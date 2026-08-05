/**
 * Form filling — docs/07-form-automation.md.
 *
 * THERE IS NO SUBMIT ENDPOINT HERE, and there never will be. The closest thing is
 * `mark-submitted`, which records that the USER submitted the application on the real page.
 * It writes a timestamp; it does not touch a browser.
 *
 * Filling is gated twice over. The profile must be confirmed (G1) and every answer on the
 * application must be approved (G3) before a single key is pressed, and that check is here
 * on the server rather than in the browser.
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { ApplicationAnswer, ConfirmedProfile } from '@ia/shared';
import { db, schema } from '../infra/db/client';
import { logger } from '../infra/logger';
import { getProfile } from '../core/profile/repository';
import {
  continueRun,
  discardRun,
  getRun,
  serializeRun,
  startRun,
  type StartInput,
} from '../core/filling/run';

interface Loaded {
  applyUrl: string;
  answers: ApplicationAnswer[];
  profile: ConfirmedProfile;
  resumePath?: string;
}

type LoadResult =
  { ok: true; data: Loaded } | { ok: false; code: string; message: string; details?: unknown };

/**
 * Gathers everything a run needs, and refuses if any gate is open.
 *
 * Returns the refusal rather than throwing so each caller can answer with the right status
 * code and the user gets told which gate stopped them.
 */
function load(applicationId: string): LoadResult {
  const row = db
    .select()
    .from(schema.application)
    .innerJoin(schema.match, eq(schema.application.matchId, schema.match.id))
    .innerJoin(schema.jobPosting, eq(schema.match.postingId, schema.jobPosting.id))
    .where(eq(schema.application.id, applicationId))
    .all()[0];

  if (!row) return { ok: false, code: 'NOT_FOUND', message: 'No such application.' };

  const profile = getProfile();
  if (!profile?.confirmedAt) {
    return {
      ok: false,
      code: 'PROFILE_INCOMPLETE',
      message: 'Confirm your profile first (gate G1). Forms are filled from confirmed facts only.',
    };
  }

  const answers = db
    .select()
    .from(schema.applicationAnswer)
    .where(eq(schema.applicationAnswer.applicationId, applicationId))
    .all() as unknown as ApplicationAnswer[];

  // Gate G3, and docs/03 invariant 2. An application with an unapproved answer cannot be
  // filled, because filling is what would put that answer in front of an employer.
  const unapproved = answers.filter((a) => !a.approvedAt);
  if (unapproved.length > 0) {
    return {
      ok: false,
      code: 'ANSWERS_NOT_APPROVED',
      message:
        unapproved.length === 1
          ? 'One answer has not been approved yet. Review it first (gate G3).'
          : `${unapproved.length} answers have not been approved yet. Review them first (gate G3).`,
      details: { questions: unapproved.map((a) => a.questionText) },
    };
  }

  const resume = row.application.resumeDocumentId
    ? db
        .select()
        .from(schema.resumeDocument)
        .where(eq(schema.resumeDocument.id, row.application.resumeDocumentId))
        .all()[0]
    : db
        .select()
        .from(schema.resumeDocument)
        .all()
        .find((r) => r.isPrimary);

  return {
    ok: true,
    data: {
      applyUrl: row.application.applyUrl,
      answers,
      profile: profile as ConfirmedProfile,
      resumePath: resume?.path,
    },
  };
}

function refuse(
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  r: Extract<LoadResult, { ok: false }>,
) {
  const status = r.code === 'NOT_FOUND' ? 404 : 400;
  return reply
    .code(status)
    .send({ error: { code: r.code, message: r.message, details: r.details } });
}

export async function fillingRoutes(app: FastifyInstance): Promise<void> {
  /** Opens the page and reads it. Types nothing. */
  app.post<{ Params: { id: string } }>('/api/applications/:id/fill', async (req, reply) => {
    const loaded = load(req.params.id);
    if (!loaded.ok) return refuse(reply, loaded);

    const input: StartInput = {
      applicationId: req.params.id,
      applyUrl: loaded.data.applyUrl,
      profile: loaded.data.profile,
      answers: loaded.data.answers,
      resumePath: loaded.data.resumePath,
    };

    const run = await startRun(input);
    if (run.state === 'failed') {
      return reply.code(502).send({ error: { code: 'FILL_FAILED', message: run.message } });
    }
    return serializeRun(run);
  });

  /**
   * Types the plan into the page that is already open.
   *
   * Also the resume point after a login wall or a bot check: the user deals with it in the
   * browser, then calls this.
   */
  app.post<{ Params: { id: string } }>(
    '/api/applications/:id/fill/continue',
    async (req, reply) => {
      const loaded = load(req.params.id);
      if (!loaded.ok) return refuse(reply, loaded);

      if (!getRun(req.params.id)) {
        return reply.code(409).send({
          error: {
            code: 'NO_RUN',
            message: 'There is no open browser for this application. Start a fill run first.',
          },
        });
      }

      try {
        const run = await continueRun({
          applicationId: req.params.id,
          applyUrl: loaded.data.applyUrl,
          profile: loaded.data.profile,
          answers: loaded.data.answers,
          resumePath: loaded.data.resumePath,
        });

        if (run.state === 'done' && run.result) {
          const skipped = run.result.results
            .filter((r) => r.status !== 'ok')
            .map((r) => ({
              label: r.field.label,
              reason:
                r.field.semantic === 'REDLINE'
                  ? 'redline'
                  : r.status === 'failed'
                    ? 'failed'
                    : 'unclassified',
              category: r.field.redlineCategory,
            }));

          db.update(schema.application)
            .set({
              // `awaiting_submit` is as far as this app will ever move an application on its
              // own. The next status is written by the user telling us they submitted it.
              status: 'awaiting_submit',
              skippedFields: skipped,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(schema.application.id, req.params.id))
            .run();

          db.insert(schema.applicationEvent)
            .values({
              id: ulid(),
              applicationId: req.params.id,
              type: 'filled',
              payload: { filled: run.result.filled, skipped: skipped.length },
            })
            .run();
        }

        return serializeRun(run);
      } catch (err) {
        logger.error({ err, applicationId: req.params.id }, 'fill continue failed');
        return reply.code(502).send({
          error: {
            code: 'FILL_FAILED',
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    },
  );

  app.get<{ Params: { id: string } }>('/api/applications/:id/fill', async (req, reply) => {
    const run = getRun(req.params.id);
    if (!run) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'No fill run is open for this application.' },
      });
    }
    return serializeRun(run);
  });

  /** Closes the browser without filling anything. */
  app.delete<{ Params: { id: string } }>('/api/applications/:id/fill', async (req, reply) => {
    await discardRun(req.params.id);
    return reply.code(204).send();
  });

  /**
   * Gate G4, recorded rather than performed.
   *
   * The user submits the application themselves, on the real page, and then tells the
   * tracker they did. This endpoint writes a timestamp. It does not open a browser, it
   * does not click anything, and it is the only thing in this codebase that has the word
   * submitted in its name.
   */
  app.post<{ Params: { id: string } }>(
    '/api/applications/:id/mark-submitted',
    async (req, reply) => {
      const row = db
        .select()
        .from(schema.application)
        .where(eq(schema.application.id, req.params.id))
        .all()[0];
      if (!row) {
        return reply
          .code(404)
          .send({ error: { code: 'NOT_FOUND', message: 'No such application.' } });
      }

      const now = new Date().toISOString();
      db.update(schema.application)
        .set({ status: 'submitted', submittedAt: now, updatedAt: now })
        .where(eq(schema.application.id, req.params.id))
        .run();

      db.insert(schema.applicationEvent)
        .values({
          id: ulid(),
          applicationId: req.params.id,
          type: 'marked_submitted',
          payload: { by: 'user' },
        })
        .run();

      await discardRun(req.params.id);
      return { id: req.params.id, status: 'submitted', submittedAt: now };
    },
  );
}
