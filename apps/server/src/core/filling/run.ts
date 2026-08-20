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
import { AGGREGATOR_REFUSAL, isAggregatorUrl } from '../discovery/sourcingPolicy';
import { detectIntervention, openSession, type BrowserSession, type Intervention } from './browser';
import { executePlan, describeFill, sameDocument, type FillResult } from './fill';
import { buildFormMap, summarizeMap, type FormMap } from './formMap';
import { buildFillPlan, summarizePlan, type FillPlan } from './plan';

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

/**
 * Which application is driving the browser RIGHT NOW, claimed before the first await.
 *
 * The only mutual exclusion this file had was `run.state === 'filling'`, and a continue does
 * not reach that state for several seconds: `detectIntervention` runs a dozen awaited
 * locator counts and `buildFormMap` reads the whole document, all of it while the state still
 * says `reading`. Two continues arriving inside that window both walked past the check and
 * both reached `executePlan`, against one page and one keyboard. `insertText` types into
 * whatever has focus, so one run's approved essay lands in the box the other has just clicked
 * into — on a real employer's form, in the user's name. Read-back catches it afterwards as a
 * pile of mismatches, which is a strange way to find out.
 *
 * A flag rather than a queue, and refusal rather than waiting: a run parks at `awaiting_user`
 * for as long as it takes a person to sign in, and a second caller queued behind that would
 * hang for minutes with nothing to show. `null` between calls, and set SYNCHRONOUSLY — the
 * moment a claim is made across an await boundary instead, this is the bug again.
 */
let driving: string | null = null;

/**
 * Takes the browser for the duration of one call, or says who has it.
 *
 * Both messages are matched by prefix in routes/filling.ts to pick a status code, so their
 * openings are load-bearing: a caller has to be able to tell "wait a moment" from "something
 * broke", and the whole reason those two are separated there is that a 502 invites a retry
 * that makes this exact race.
 */
function claimBrowser(applicationId: string): void {
  if (driving === applicationId) {
    throw new Error('This application is already being filled. Wait for that run to finish.');
  }
  if (driving !== null) {
    throw new Error(
      'Another application has the browser open. There is one browser profile on this ' +
        'machine, so one application can be filled at a time. Finish that one, or discard ' +
        'it, and try this again.',
    );
  }
  driving = applicationId;
}

function releaseBrowser(applicationId: string): void {
  if (driving === applicationId) driving = null;
}

/**
 * Another application with a browser window already open, if there is one.
 *
 * Every run launches `launchPersistentContext` against the single shared profile directory
 * (browser.ts), so a second window cannot exist: Chromium refuses the profile lock. Nothing
 * stopped a second application from trying, though — runs are keyed per application, and the
 * ordinary flow gets there easily, with run A parked on a login wall while the user goes and
 * starts application B. B failed on the lock and surfaced as a 502 carrying a raw Playwright
 * message about a directory, which explains neither what happened nor the one thing that
 * fixes it.
 *
 * A run without a session holds no window — it failed to open, or has already been
 * discarded — so it does not stand in the way.
 */
function browserHeldBy(applicationId: string): FillRun | undefined {
  for (const run of runs.values()) {
    if (run.applicationId === applicationId || !run.session) continue;
    /**
     * A window the user already closed holds nothing, whatever the registry still thinks.
     *
     * `session !== undefined` was the whole test, and it made a regression out of the most
     * ordinary ending this flow has: the user reviews the filled form, submits it on the real
     * page, and closes the Chromium window with the X. Nothing listens for that, so the
     * finished run sat in the map holding a dead session and every OTHER application was
     * refused with "another application has the browser open" — about a browser that was not
     * open — until the user worked out which panel held the ghost and pressed a Close button
     * for a window that had already gone. Before the mutual exclusion existed, starting the
     * next application simply worked.
     *
     * `page.isClosed()` answers synchronously off Playwright's own state, so it costs nothing
     * and cannot itself throw at a browser that has gone. The context is closed as well as
     * forgotten: dropping the entry alone would leave the object holding the profile-directory
     * lock that every later run needs, which is the orphan this file already fixed once.
     */
    if (run.session.page.isClosed()) {
      void run.session.close().catch(() => undefined);
      runs.delete(run.applicationId);
      continue;
    }
    return run;
  }
  return undefined;
}

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
    // The address the form was actually read from, which is not always the one the
    // application was saved with: a sign-in redirect, a wizard step or a stale link can put
    // the browser somewhere else entirely, and `url` alone would name the page the tool
    // MEANT to fill as the page it did fill.
    pageUrl: run.map?.url ?? null,
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
export class SourceRefusedError extends Error {
  readonly code = 'SOURCE_REFUSED' as const;
}

/**
 * Where the browser ACTUALLY IS, checked against the policy — not where it was asked to go.
 *
 * `startRun` tests the URL it is about to open and then hands it to a real browser, which
 * follows 3xx, meta-refresh and `location =` on its own. `openSession` installs a route
 * handler that aborts a document request to one of these hosts, which is the primary defence
 * and refuses the request outright; this is the second, for the cases a request filter cannot
 * see — a page already open from an earlier call, a history navigation, a handler installed
 * after a redirect chain has begun.
 *
 * Run before anything READS the page and before anything types into it. The order matters:
 * reading a page is cheap and typing into it is not, and the value being typed is the
 * student's name, email and approved answers.
 */
function refuseIfAggregator(run: FillRun): void {
  const here = run.session?.page.url();
  if (here !== undefined && isAggregatorUrl(here)) {
    throw new SourceRefusedError(
      `This application's page redirected to ${new URL(here).hostname}. ${AGGREGATOR_REFUSAL}`,
    );
  }
}

export async function startRun(input: StartInput): Promise<FillRun> {
  /**
   * Refused before the browser opens, and this is the sharpest edge of the whole policy.
   *
   * The browser this run drives is `launchPersistentContext` over a profile directory that
   * exists precisely so sessions survive between runs — the student's own logins. Navigating
   * it to an aggregator is not the ordinary automated read the rest of the tool declines: it
   * is an automated visit CARRYING THEIR SIGNED-IN SESSION, which for Handshake is their
   * university's careers account and the one place a ban costs them something real.
   *
   * Reachable because the paste path stores the pasted address as `apply_url` — by design, as
   * the student's way back — and G2 copies it onto the application row, where this run reads
   * it. So the careful path, the one built to avoid contacting those sites, ended at a
   * signed-in browser pointed straight at them. Nothing else in the fill path checked: before
   * this, `isAggregatorUrl` had exactly one caller in the whole repo.
   */
  if (isAggregatorUrl(input.applyUrl)) {
    throw new SourceRefusedError(AGGREGATOR_REFUSAL);
  }

  // Claimed before anything is awaited, and held across the discard, the launch and the read.
  // A second start for this application used to arrive while the first was still inside
  // `openSession`: it found a run whose `session` was undefined, so the discard closed
  // nothing, deleted the map entry, and registered its own — and when the first launch
  // resolved, its BrowserContext was attached to an object no longer in `runs`. Unreachable
  // by `discardRun`, by `closeAllRuns` on shutdown, and by the close that delete-all does
  // before removing the profile directory, so it sat there holding the lock on a directory
  // every later run needs and delete-all is trying to remove.
  claimBrowser(input.applicationId);
  try {
    const held = browserHeldBy(input.applicationId);
    if (held) {
      // Naming the page it is sitting on, because the shared enum promises this message
      // "says which" and it did not: the user was told to go and finish or discard a run
      // without being told which one, on a screen that shows one application at a time.
      throw new Error(
        'Another application has the browser open. There is one browser profile on this ' +
          'machine, so one application can be filled at a time. Finish that one, or close ' +
          `its browser, and try this again. It is the run on ${held.url}`,
      );
    }
    return await open(input);
  } finally {
    releaseBrowser(input.applicationId);
  }
}

/**
 * Raised when the run was discarded out from under a launch that was still starting.
 *
 * Thrown rather than turned into a `failed` run like every other problem in here, because it
 * is not one: nothing about the browser or the page went wrong, the user asked for this run
 * to go away and it did. A `failed` run would be answered with a 502 saying the site broke,
 * and it would be a run object the registry no longer holds — a thing with a state, sitting
 * outside the map that is supposed to be the only place run state lives. Named rather than
 * matched loosely so the rethrow below cannot start catching real launch failures.
 */
const DISCARDED_WHILE_OPENING = 'This fill run was discarded while the browser was opening.';

/** The same, one stage later: the user stopped a fill that was already typing. */
const DISCARDED_WHILE_FILLING = 'This fill run was stopped while it was filling.';

async function open(input: StartInput): Promise<FillRun> {
  await discardRun(input.applicationId);

  const run: FillRun = {
    applicationId: input.applicationId,
    state: 'opening',
    url: input.applyUrl,
    message: 'Opening the application page.',
    startedAt: new Date().toISOString(),
  };
  /**
   * Sessionless leftovers are swept before the new run is filed.
   *
   * `runs` only ever loses an entry to an explicit discard, a mark-submitted, or a restart of
   * the same application — so a run that failed to open, or whose browser the user closed,
   * stayed in the map for the life of the process. None of them holds anything (`browserHeldBy`
   * skips a run with no session, and closes one whose page has gone), so this is slow bloat
   * rather than a wedge; it is swept here because a start is the one moment that already knows
   * the map is about to change.
   */
  for (const [id, other] of runs) {
    if (id !== input.applicationId && !other.session) runs.delete(id);
  }
  runs.set(input.applicationId, run);

  try {
    const session = await openSession({ headless: input.headless ?? false });
    // Discarding does not wait for the claim above — shutdown and delete-all have to be able
    // to close a browser whatever else is happening — so the entry this launch belongs to can
    // still have been removed while Chromium was starting. Attaching the session to a run
    // nobody holds is the orphan by another route; closing it here is the only chance.
    if (runs.get(input.applicationId) !== run) {
      await session.close();
      throw new Error(DISCARDED_WHILE_OPENING);
    }
    run.session = session;
    await run.session.page.goto(input.applyUrl, { waitUntil: 'domcontentloaded' });
    // Where it landed, which is not always where it was sent.
    refuseIfAggregator(run);

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
    /**
     * What will be typed, not what was found.
     *
     * `summarizeMap` derives "fillable" as every classified field minus the unknown and
     * redlined ones — so a field the tool RECOGNISED but has no value for (a GPA the profile
     * does not carry, a referral source, an essay with no approved answer) was counted as one
     * it was about to fill. That number is what the user reads before a key is pressed, and
     * the plan already knows better: it has separated those into skips.
     *
     * Both lines, because they answer different questions. The map line says what the page
     * turned out to contain, which is how someone tells a form that failed to render from one
     * that rendered and had little on it. The plan line says what this run will do.
     */
    run.message = `${summarizeMap(run.map)} ${summarizePlan(run.plan)}`;
    return run;
  } catch (err) {
    // See DISCARDED_WHILE_OPENING: the user asked for this run to go away, which is not a
    // failure to report and not a run to hand back.
    if (err instanceof Error && err.message === DISCARDED_WHILE_OPENING) throw err;
    /**
     * A refusal is ours, not the site's, and it has to travel as one.
     *
     * Turned into a `failed` run it would reach the route as a 502 saying the page broke —
     * inviting a retry of something that will never be permitted, and blaming an employer for
     * a rule this tool applies to itself. routes/filling.ts maps SourceRefusedError to a 400
     * naming the paste-the-text path, and it can only do that if the error arrives.
     *
     * The session is closed on the way past: a refusal that left the browser parked on that
     * host would defeat the point of refusing, and would hold the profile-directory lock every
     * later run needs.
     */
    if (err instanceof SourceRefusedError) {
      await discardRun(input.applicationId);
      throw err;
    }
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

  /**
   * One caller in the page at a time, claimed before the first await.
   *
   * This was `run.state === 'filling'`, which is the wrong question: a continue spends its
   * first several seconds in `detectIntervention` and `buildFormMap` with the state still
   * reading `reading`, and two continues arriving inside that window both walked past the
   * check and both reached `executePlan` — one page, one keyboard, `insertText` going to
   * whatever has focus. The UI cannot produce it (its buttons disable while a call is in
   * flight), but the local API is a supported way to drive this server, a second tab can be
   * looking at a stale screen, and until routes/filling.ts learned to answer a conflict with
   * 409 the honest 502 on the first call invited a client to retry straight into it.
   */
  claimBrowser(input.applicationId);
  try {
    return await drive(run, input);
  } finally {
    releaseBrowser(input.applicationId);
  }
}

async function drive(run: FillRun, input: StartInput): Promise<FillRun> {
  if (!run.session) {
    throw new Error('No open fill run for this application. Start one first.');
  }

  // Again here, because this re-reads and types into whatever the page currently shows — and
  // between the start of a run and a continue, the person has been using that browser: they
  // signed in, they clicked through a wizard, they may be somewhere else entirely.
  refuseIfAggregator(run);

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

    // A page with nothing on it to fill is not a form this tool has anything to say about.
    // Reporting it `done` walked the application on to `awaiting_submit` and told the user to
    // go and submit a form that had never been typed into — the ordinary outcome on a career
    // site whose form renders after the page load this run waited for.
    if (run.plan.actions.length === 0 && run.plan.skips.length === 0) {
      run.state = 'failed';
      run.message =
        'Nothing on this page could be read as a form field, so nothing was typed. ' +
        'Check the page in the browser window — the form may not have loaded yet.';
      return run;
    }

    run.state = 'filling';
    run.result = await executePlan(run.session.page, run.plan, {
      // The page the map was just read from. Anything else the browser wanders onto mid-fill
      // — a select whose onchange navigates, a form that submits itself — stops the run
      // rather than sending the rest of the plan into a document nobody scanned.
      documentUrl: run.map.url,
      // The mark left when these controls were numbered. The URL alone cannot tell a real
      // navigation from a pushState step; this can.
      documentToken: run.map.documentToken,
      onProgress: (r) => {
        publish({
          type: 'fill.step',
          applicationId: input.applicationId,
          field: r.field.label,
          status: r.status,
          note: r.note,
        });
      },
    });

    /**
     * A run the user stopped is not a run that finished.
     *
     * Discard is offered while a fill is in flight — that is the whole point of the "Close
     * the browser and stop" button — and it closes the context out from under `executePlan`.
     * Every per-field error is caught and turned into `status: 'failed'`, so the fill returns
     * NORMALLY with a pile of failures, and this line then called it `done`: the route
     * advanced the application through `filled` to `awaiting_submit`, wrote a `filled` event,
     * and overwrote `skippedFields`. The user pressed stop and the tracker told them the form
     * was filled and ready to submit. G4 still held — nothing reached `submitted` — but
     * recording an abandoned fill as a completed one is the failure this repo likes least.
     *
     * The registry is the authority on whether the run is still the user's: `discardRun`
     * removes the entry, so an entry that is no longer this object means it was discarded.
     */
    if (runs.get(input.applicationId) !== run) {
      throw new Error(DISCARDED_WHILE_FILLING);
    }

    run.state = 'done';
    run.message = describeFill(run.result);
    if (!sameDocument(run.map.url, run.url)) {
      // Naming the page is the only thing that can catch this. The run was started against
      // one address and filled another — a sign-in redirect, a wizard that moved on, a tab
      // the user navigated — and the application is about to be recorded as filled either way.
      run.message +=
        ` This was the form at ${run.map.url}, not the address saved with this ` +
        'application. Check it is the right page before you submit.';
    }

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
    // A run the user stopped is gone from the registry already, and marking a discarded
    // object `failed` would be writing a verdict onto something nobody holds — and would
    // hand the route a 502 saying the site broke, about a button the user pressed on purpose.
    if (err instanceof Error && err.message === DISCARDED_WHILE_FILLING) throw err;
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
