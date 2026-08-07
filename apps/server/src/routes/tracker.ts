/**
 * The tracker — docs/11 § M7.
 *
 * The status endpoint is the interesting one. It refuses any transition the model says the
 * tool may not make, which in practice means it refuses to be told an application was
 * submitted by anything other than a person clicking the button that says so. That check
 * is server-side for the same reason gate G3's is: a client-side rule is a suggestion.
 *
 * It holds G3 itself too, for the two statuses that claim the form has been filled from the
 * approved answers. The fill routes are where G3 stops anything reaching an employer, but
 * this column is what the board and the CSV export read, so it has to be as honest.
 */
import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { z } from 'zod';
import { ApplicationStatus } from '@ia/shared';
import { db, schema } from '../infra/db/client';
import { discardRun } from '../core/filling/run';
import { csvFilename, toCsv } from '../core/tracking/exportCsv';
import { buildReminders, draftFollowUp, draftWithdrawal } from '../core/tracking/reminders';
import {
  ADVANCED as ADVANCED_STATUSES,
  computeStats,
  RESPONDED as RESPONDED_STATUSES,
} from '../core/tracking/stats';
import { canTransition, derive, SET_BY, type TrackedApplication } from '../core/tracking/status';

/**
 * Every tracked application, with the counts the derived state needs.
 *
 * One query plus one grouped query rather than a per-row lookup: the answer counts are the
 * only thing the board needs beyond the application row, and N+1 over a season's worth of
 * applications is a real cost for a local SQLite file being hit on every page load.
 */
function loadAll(): TrackedApplication[] {
  const rows = db
    .select()
    .from(schema.application)
    .innerJoin(schema.match, eq(schema.application.matchId, schema.match.id))
    .innerJoin(schema.jobPosting, eq(schema.match.postingId, schema.jobPosting.id))
    .orderBy(desc(schema.application.createdAt))
    .all();

  /**
   * The first moment each application heard back, out of the status-change history.
   *
   * Every transition already writes a `status_changed` event; nothing read them. Reply
   * time was measured from submission to the present instead, so the figure under
   * "Typical reply time" grew every day for applications that had been answered long ago.
   */
  const respondedAt = new Map<string, string>();
  // The same history answers a second question: did this application ever reach an
  // interview or an offer, whatever became of it afterwards. Reading the CURRENT status
  // instead drops every interview that ended in a rejection, which is most of them, so the
  // figure shown as "reached interview" was really "is sitting at interview right now".
  const advancedAt = new Map<string, string>();
  for (const e of db
    .select()
    .from(schema.applicationEvent)
    .where(eq(schema.applicationEvent.type, 'status_changed'))
    .orderBy(schema.applicationEvent.at)
    .all()) {
    const to = (e.payload as { to?: TrackedApplication['status'] } | null)?.to;
    if (!to) continue;
    if (RESPONDED_STATUSES.includes(to) && !respondedAt.has(e.applicationId)) {
      respondedAt.set(e.applicationId, e.at);
    }
    if (ADVANCED_STATUSES.includes(to) && !advancedAt.has(e.applicationId)) {
      advancedAt.set(e.applicationId, e.at);
    }
  }

  const answers = db.select().from(schema.applicationAnswer).all();
  const byApp = new Map<string, { total: number; approved: number }>();
  for (const a of answers) {
    const cur = byApp.get(a.applicationId) ?? { total: 0, approved: 0 };
    byApp.set(a.applicationId, {
      total: cur.total + 1,
      approved: cur.approved + (a.approvedAt ? 1 : 0),
    });
  }

  return rows.map((r) => {
    const counts = byApp.get(r.application.id) ?? { total: 0, approved: 0 };
    return {
      id: r.application.id,
      status: r.application.status as TrackedApplication['status'],
      company: r.job_posting.company,
      title: r.job_posting.title,
      applyUrl: r.application.applyUrl,
      source: r.job_posting.atsVendor,
      createdAt: r.application.createdAt,
      updatedAt: r.application.updatedAt,
      submittedAt: r.application.submittedAt,
      respondedAt: respondedAt.get(r.application.id) ?? null,
      advancedAt: advancedAt.get(r.application.id) ?? null,
      deadlineAt: r.application.deadlineAt,
      answerCount: counts.total,
      approvedCount: counts.approved,
    };
  });
}

const StatusBody = z.object({
  status: ApplicationStatus,
  note: z.string().max(2000).optional(),
});

/**
 * The statuses that assert the approved answers are on the employer's form.
 *
 * Both of them, not just `filled` — `awaiting_submit` is the one the board renders as "Ready
 * for you" with "The form is filled. Read it and submit it yourself." beside it, which is the
 * stronger claim of the two.
 */
const CLAIMS_THE_FORM_IS_FILLED: TrackedApplication['status'][] = ['filled', 'awaiting_submit'];

export async function trackerRoutes(app: FastifyInstance): Promise<void> {
  /** The board, the table, and the nudges all read from this. */
  app.get('/api/tracker', async () => {
    const apps = loadAll();
    const now = new Date();
    return {
      applications: apps.map((a) => ({ ...a, derived: derive(a, now) })),
      reminders: buildReminders(apps, now),
      stats: computeStats(apps, now),
    };
  });

  /**
   * Records what happened. Refuses anything the tool is not entitled to claim.
   */
  app.post<{ Params: { id: string } }>('/api/applications/:id/status', async (req, reply) => {
    const parsed = StatusBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: parsed.error.issues[0]?.message ?? 'Expected { status }.',
        },
      });
    }

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

    const from = row.status as TrackedApplication['status'];
    const to = parsed.data.status;

    // This endpoint is only ever reached by a person clicking something, so `user` is the
    // honest caller. The tool's own transitions happen inside the fill run, not here.
    const allowed = canTransition(from, to, 'user');
    if (!allowed.ok) {
      return reply
        .code(409)
        .send({ error: { code: 'ILLEGAL_TRANSITION', message: allowed.reason } });
    }

    // Gate G3 holds on this column too, not only at the fill boundary.
    //
    // `filled` and `awaiting_submit` are the two statuses that assert the approved answers
    // are on the employer's form. routes/filling.ts refuses to open a browser while any
    // answer is unapproved; nothing looked here, and `answers_ready → filled → awaiting_submit`
    // is a legal walk for a user, so a client could put an application in "Ready for you" —
    // "The form is filled. Read it and submit it yourself." — with every answer still
    // undrafted. The board said so, and so did the CSV export the user keeps as their record.
    //
    // Only a transition that newly claims one of those statuses is checked. Re-recording the
    // status a row already has, or retreating from `filled` back to `answers_ready`, claims
    // nothing new.
    if (to !== from && CLAIMS_THE_FORM_IS_FILLED.includes(to)) {
      const unapproved = db
        .select()
        .from(schema.applicationAnswer)
        .where(eq(schema.applicationAnswer.applicationId, req.params.id))
        .all()
        .filter((a) => !a.approvedAt);
      if (unapproved.length > 0) {
        return reply.code(409).send({
          error: {
            code: 'ANSWERS_NOT_APPROVED',
            message:
              (unapproved.length === 1
                ? 'One answer has not been approved yet. Review it first (gate G3).'
                : `${unapproved.length} answers have not been approved yet. Review them first (gate G3).`) +
              ` An application cannot be recorded as ${to.replace(/_/g, ' ')} until they are.`,
            details: { questions: unapproved.map((a) => a.questionText) },
          },
        });
      }
    }

    const now = new Date().toISOString();
    db.update(schema.application)
      .set({
        status: to,
        // Marking submitted here has the same meaning as mark-submitted: the user did it.
        submittedAt: to === 'submitted' ? (row.submittedAt ?? now) : row.submittedAt,
        updatedAt: now,
      })
      .where(eq(schema.application.id, req.params.id))
      .run();

    db.insert(schema.applicationEvent)
      .values({
        id: ulid(),
        applicationId: req.params.id,
        type: 'status_changed',
        payload: { from, to, by: 'user', note: parsed.data.note ?? null },
      })
      .run();

    // Once an application has left the tool's own statuses there is nothing left to fill,
    // so any browser still sitting on its form is closed — the same thing mark-submitted
    // does. Leaving it open left a window pointed at a form the user had already sent, and
    // the review panel goes on offering its "continue filling" buttons for as long as a run
    // exists to continue.
    if (SET_BY[to] === 'user') await discardRun(req.params.id);

    return { id: req.params.id, status: to, updatedAt: now };
  });

  /**
   * A follow-up, as text.
   *
   * Returned rather than sent. Nothing in this app has mail credentials, and an email
   * going out under someone's name is theirs to send for the same reason an application is
   * theirs to submit.
   */
  app.get<{ Params: { id: string }; Querystring: { kind?: string } }>(
    '/api/applications/:id/draft-message',
    async (req, reply) => {
      const found = loadAll().find((a) => a.id === req.params.id);
      if (!found) {
        return reply
          .code(404)
          .send({ error: { code: 'NOT_FOUND', message: 'No such application.' } });
      }
      const kind = req.query.kind === 'withdrawal' ? 'withdrawal' : 'follow_up';
      return {
        kind,
        text: kind === 'withdrawal' ? draftWithdrawal(found) : draftFollowUp(found),
        note: 'This is a draft for you to send yourself. Nothing here sends email.',
      };
    },
  );

  /** Everything, as a spreadsheet. Your data leaves whenever you want it to. */
  app.get('/api/tracker/export.csv', async (_req, reply) => {
    const csv = toCsv(loadAll());
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${csvFilename()}"`)
      .send(csv);
  });
}
