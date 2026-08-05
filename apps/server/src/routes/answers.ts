/**
 * Answer drafting and review — gate G3.
 *
 * The invariant this file enforces (docs/03, invariant 2): an answer cannot be approved
 * while FactGuard holds a blocking verdict against it. That check lives on the server,
 * not in the browser, because a client-side gate is a suggestion.
 *
 * There is deliberately no endpoint that approves in bulk, and none that approves as a
 * side effect of drafting. Approval is one answer, one person, one click.
 */
import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { AnswerEvidence, AnswerFlag, ConfirmedProfile, StyleProfile } from '@ia/shared';
import { db, schema } from '../infra/db/client';
import { decryptField } from '../infra/crypto/fieldCrypto';
import {
  claudeCliSelfTest,
  describeAccess,
  NoModelAccessError,
  resetBackend,
  resetCliProbe,
  resolveBackend,
} from '../infra/llm';
import { publish } from '../infra/events';
import { logger } from '../infra/logger';
import { getProfile } from '../core/profile/repository';
import { draftAnswer } from '../core/writing/draft';
import { guardDraft, type GuardResult } from '../core/writing/factGuard';
import { retrieveEvidence } from '../core/writing/retrieve';
import { critiqueStyle, describeMatch } from '../core/writing/styleCritic';
import { findTells } from '../core/writing/tellScrub';
import {
  classifyQuestion,
  describeEditing,
  editFraction,
  findReusable,
  listLibrary,
  saveApproved,
  wordEditDistance,
} from '../core/writing/answerLibrary';

// ─────────────────────────────────────────────────────────────────── loaders

function loadStyle(): StyleProfile | undefined {
  const row = db
    .select()
    .from(schema.styleProfile)
    .orderBy(desc(schema.styleProfile.computedAt))
    .all()[0];
  return row ? (row.metrics as StyleProfile) : undefined;
}

function loadSamples(): string[] {
  return db
    .select()
    .from(schema.writingSample)
    .orderBy(desc(schema.writingSample.wordCount))
    .all()
    .map((r) => decryptField(r.content, r.id));
}

interface ApplicationContext {
  applicationId: string;
  company: string;
  title: string;
  description: string;
  applyUrl: string;
}

function loadContext(applicationId: string): ApplicationContext | null {
  const row = db
    .select()
    .from(schema.application)
    .innerJoin(schema.match, eq(schema.application.matchId, schema.match.id))
    .innerJoin(schema.jobPosting, eq(schema.match.postingId, schema.jobPosting.id))
    .where(eq(schema.application.id, applicationId))
    .all()[0];

  if (!row) return null;
  return {
    applicationId,
    company: row.job_posting.company,
    title: row.job_posting.title,
    description: row.job_posting.descriptionText,
    applyUrl: row.application.applyUrl,
  };
}

/** The confirmed profile, or null. Nothing downstream may read an unconfirmed one. */
function confirmedProfile(): ConfirmedProfile | null {
  const p = getProfile();
  return p?.confirmedAt ? (p as ConfirmedProfile) : null;
}

// ────────────────────────────────────────────────────────── verification pass

interface Verified {
  guard: GuardResult;
  evidence: AnswerEvidence[];
  flags: AnswerFlag[];
  style: ReturnType<typeof critiqueStyle>;
  styleNote: string;
}

/**
 * Re-verifies text against the profile. Runs on every draft AND on every user edit —
 * an approved answer must be verified as it stands, not as it was generated.
 */
function verify(
  text: string,
  question: string,
  profile: ConfirmedProfile,
  style: StyleProfile | undefined,
  postingContext: string,
): Verified {
  const evidence = retrieveEvidence(profile, question, { postingContext });
  const guard = guardDraft(text, evidence);
  const tells = findTells(text);
  const styleReport = critiqueStyle(text, style);

  const flags: AnswerFlag[] = [
    ...guard.blocking.map((c) => ({
      type: c.verdict === 'overstated' ? ('overstated' as const) : ('unsupported' as const),
      span: c.span,
      note: c.reason ?? 'Not supported by your profile.',
    })),
    ...tells.map((t) => ({ type: 'ai_tell' as const, span: t.span, note: t.note })),
    ...styleReport.drift
      .filter((d) => d.severity > 0.4)
      .map((d) => ({ type: 'style_drift' as const, span: { start: 0, end: 0 }, note: d.note })),
  ];

  return {
    guard,
    evidence: guard.claims.map((c) => ({
      claim: c.claim,
      verdict: c.verdict,
      profileRef: c.profileRef,
      quote: c.quote,
    })),
    flags,
    style: styleReport,
    styleNote: describeMatch(styleReport),
  };
}

function answerPayload(row: typeof schema.applicationAnswer.$inferSelect): Record<string, unknown> {
  const text = row.finalText || row.draftText;
  return {
    id: row.id,
    applicationId: row.applicationId,
    questionText: row.questionText,
    fieldKey: row.fieldKey,
    answerType: row.answerType,
    draftText: row.draftText,
    finalText: row.finalText,
    text,
    editDistance: row.editDistance,
    editSummary: describeEditing(editFraction(row.draftText, text)),
    evidence: row.evidence ?? [],
    flags: row.flags ?? [],
    approvedAt: row.approvedAt,
    archetype: classifyQuestion(row.questionText).archetype,
  };
}

// ─────────────────────────────────────────────────────────────────── schemas

const QuestionBody = z.object({
  questionText: z.string().min(3, 'A question needs some text.'),
  fieldKey: z.string().default(''),
  answerType: z.enum(['short_text', 'long_text', 'select', 'boolean']).default('long_text'),
  maxWords: z.number().int().positive().max(2000).optional(),
});

const EditBody = z.object({ text: z.string() });

// ────────────────────────────────────────────────────────────────────── routes

export async function answerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/applications', async () => {
    const rows = db
      .select()
      .from(schema.application)
      .innerJoin(schema.match, eq(schema.application.matchId, schema.match.id))
      .innerJoin(schema.jobPosting, eq(schema.match.postingId, schema.jobPosting.id))
      .orderBy(desc(schema.application.createdAt))
      .all();

    return {
      applications: rows.map((r) => {
        const answers = db
          .select()
          .from(schema.applicationAnswer)
          .where(eq(schema.applicationAnswer.applicationId, r.application.id))
          .all();
        return {
          id: r.application.id,
          status: r.application.status,
          company: r.job_posting.company,
          title: r.job_posting.title,
          applyUrl: r.application.applyUrl,
          deadlineAt: r.application.deadlineAt,
          submittedAt: r.application.submittedAt,
          createdAt: r.application.createdAt,
          answerCount: answers.length,
          approvedCount: answers.filter((a) => a.approvedAt).length,
          blockedCount: answers.filter((a) => ((a.flags ?? []) as AnswerFlag[]).some(isBlocking))
            .length,
        };
      }),
    };
  });

  app.get<{ Params: { id: string } }>('/api/applications/:id', async (req, reply) => {
    const ctx = loadContext(req.params.id);
    if (!ctx) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'No such application.' } });
    }

    const answers = db
      .select()
      .from(schema.applicationAnswer)
      .where(eq(schema.applicationAnswer.applicationId, req.params.id))
      .all();

    const access = await describeAccess();
    return {
      ...ctx,
      id: req.params.id,
      answers: answers.map(answerPayload),
      canDraft: access.available,
      modelAccess: access,
    };
  });

  /**
   * Adds a question by hand. Until M6 reads forms directly, this is how a question gets
   * into the workspace — paste it from the application page.
   */
  app.post<{ Params: { id: string } }>('/api/applications/:id/questions', async (req, reply) => {
    const ctx = loadContext(req.params.id);
    if (!ctx) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'No such application.' } });
    }

    const parsed = QuestionBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: parsed.error.issues[0]?.message ?? 'Invalid question.',
        },
      });
    }

    const id = ulid();
    const { questionText, fieldKey, answerType } = parsed.data;

    // Offer a previously approved answer, if one is safe to reuse for this company.
    const reusable = findReusable(questionText, ctx.company);
    const profile = confirmedProfile();

    let evidence: AnswerEvidence[] = [];
    let flags: AnswerFlag[] = [];
    if (reusable && profile) {
      const v = verify(reusable.text, questionText, profile, loadStyle(), ctx.description);
      evidence = v.evidence;
      flags = v.flags;
    }

    db.insert(schema.applicationAnswer)
      .values({
        id,
        applicationId: req.params.id,
        questionText,
        fieldKey: fieldKey || `q_${id.slice(-6).toLowerCase()}`,
        answerType,
        draftText: reusable?.text ?? '',
        finalText: reusable?.text ?? '',
        evidence,
        flags,
        // Reuse pre-fills. It never approves — G3 applies per application.
        approvedAt: null,
      })
      .run();

    const row = db
      .select()
      .from(schema.applicationAnswer)
      .where(eq(schema.applicationAnswer.id, id))
      .all()[0]!;

    return reply.code(201).send({
      ...answerPayload(row),
      reusedFrom: reusable ? { useCount: reusable.useCount, company: reusable.company } : null,
    });
  });

  app.delete<{ Params: { id: string } }>('/api/answers/:id', async (_req, reply) => {
    db.delete(schema.applicationAnswer)
      .where(eq(schema.applicationAnswer.id, _req.params.id))
      .run();
    return reply.code(204).send();
  });

  /** Drafts (or redrafts) one answer. Never approves it. */
  app.post<{ Params: { id: string }; Body: { maxWords?: number } }>(
    '/api/answers/:id/draft',
    async (req, reply) => {
      const row = db
        .select()
        .from(schema.applicationAnswer)
        .where(eq(schema.applicationAnswer.id, req.params.id))
        .all()[0];
      if (!row) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such answer.' } });
      }

      const profile = confirmedProfile();
      if (!profile) {
        return reply.code(400).send({
          error: {
            code: 'PROFILE_INCOMPLETE',
            message: 'Confirm your profile first. Drafts are built from confirmed facts only.',
          },
        });
      }
      if (!(await resolveBackend())) {
        const access = await describeAccess();
        return reply.code(400).send({
          error: {
            code: 'NO_MODEL_ACCESS',
            message:
              'Drafting needs either the Claude Code CLI (signed in with your Claude account) ' +
              'or an Anthropic API key. You can also write the answer yourself, and it will ' +
              'still be fact-checked against your profile.',
            details: { modelAccess: access },
          },
        });
      }

      const ctx = loadContext(row.applicationId);
      const emit = (stage: 'retrieve' | 'generate' | 'factguard' | 'style' | 'done'): void =>
        publish({
          type: 'draft.progress',
          applicationId: row.applicationId,
          questionId: row.id,
          stage,
        });

      emit('retrieve');
      let result;
      try {
        emit('generate');
        result = await draftAnswer({
          profile,
          question: row.questionText,
          maxWords: req.body?.maxWords,
          postingContext: ctx ? `${ctx.title} at ${ctx.company}\n\n${ctx.description}` : undefined,
          style: loadStyle(),
          samples: loadSamples(),
        });
      } catch (err) {
        logger.error({ err, answerId: row.id }, 'drafting failed');
        // A usage limit or a missing CLI already carries a message written for the user;
        // passing it through beats replacing it with a generic failure.
        if (err instanceof NoModelAccessError) {
          return reply.code(503).send({ error: { code: 'NO_MODEL_ACCESS', message: err.message } });
        }
        return reply.code(502).send({
          error: {
            code: 'DRAFT_FAILED',
            message: 'The model call failed. Try again, or write the answer yourself.',
          },
        });
      }

      emit('factguard');
      emit('style');
      const v = verify(result.text, row.questionText, profile, loadStyle(), ctx?.description ?? '');

      db.update(schema.applicationAnswer)
        .set({
          draftText: result.text,
          finalText: result.text,
          editDistance: 0,
          evidence: v.evidence,
          flags: v.flags,
          // A redraft invalidates any prior approval. The text changed.
          approvedAt: null,
        })
        .where(eq(schema.applicationAnswer.id, row.id))
        .run();

      emit('done');

      const updated = db
        .select()
        .from(schema.applicationAnswer)
        .where(eq(schema.applicationAnswer.id, row.id))
        .all()[0]!;

      return {
        ...answerPayload(updated),
        revised: result.revised,
        unresolved: result.unresolved,
        styleNote: v.styleNote,
        styleMatch: v.style.match,
      };
    },
  );

  /** Saves the user's edit and re-verifies it. Editing always clears approval. */
  app.patch<{ Params: { id: string } }>('/api/answers/:id', async (req, reply) => {
    const row = db
      .select()
      .from(schema.applicationAnswer)
      .where(eq(schema.applicationAnswer.id, req.params.id))
      .all()[0];
    if (!row) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such answer.' } });
    }

    const parsed = EditBody.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: 'VALIDATION_FAILED', message: 'Expected { text }.' } });
    }

    const profile = confirmedProfile();
    const ctx = loadContext(row.applicationId);
    const text = parsed.data.text;

    // Verification needs a confirmed profile. Without one, the edit is saved but nothing
    // is marked verified — better than showing stale flags against new text.
    const v = profile
      ? verify(text, row.questionText, profile, loadStyle(), ctx?.description ?? '')
      : null;

    db.update(schema.applicationAnswer)
      .set({
        finalText: text,
        editDistance: wordEditDistance(row.draftText, text),
        evidence: v?.evidence ?? [],
        flags: v?.flags ?? [],
        approvedAt: null,
      })
      .where(eq(schema.applicationAnswer.id, row.id))
      .run();

    const updated = db
      .select()
      .from(schema.applicationAnswer)
      .where(eq(schema.applicationAnswer.id, row.id))
      .all()[0]!;

    return { ...answerPayload(updated), styleNote: v?.styleNote ?? null, verified: v !== null };
  });

  /**
   * Gate G3.
   *
   * Refuses while any blocking flag stands. The user's route past a false positive is to
   * edit the sentence or add the fact to their profile — not to click through the
   * warning. There is no override parameter, on purpose.
   */
  app.post<{ Params: { id: string } }>('/api/answers/:id/approve', async (req, reply) => {
    const row = db
      .select()
      .from(schema.applicationAnswer)
      .where(eq(schema.applicationAnswer.id, req.params.id))
      .all()[0];
    if (!row) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such answer.' } });
    }

    const text = row.finalText || row.draftText;
    if (text.trim().length === 0) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_FAILED', message: 'There is nothing to approve yet.' },
      });
    }

    // Re-verify at approval time rather than trusting stored flags. Cheap, and it closes
    // the window where a profile edit invalidates an answer nobody re-checked.
    const profile = confirmedProfile();
    const ctx = loadContext(row.applicationId);
    const v = profile
      ? verify(text, row.questionText, profile, loadStyle(), ctx?.description ?? '')
      : null;

    const blocking = v ? v.guard.blocking : [];
    if (blocking.length > 0) {
      db.update(schema.applicationAnswer)
        .set({ evidence: v!.evidence, flags: v!.flags })
        .where(eq(schema.applicationAnswer.id, row.id))
        .run();

      return reply.code(409).send({
        error: {
          code: 'UNVERIFIED_CLAIMS',
          message:
            blocking.length === 1
              ? 'One sentence claims something your profile does not support. Fix it, or add the fact to your profile.'
              : `${blocking.length} sentences claim things your profile does not support. Fix them, or add the facts to your profile.`,
          details: {
            claims: blocking.map((c) => ({ claim: c.claim, reason: c.reason, span: c.span })),
          },
        },
      });
    }

    const now = new Date().toISOString();
    db.update(schema.applicationAnswer)
      .set({
        approvedAt: now,
        evidence: v?.evidence ?? [],
        flags: v?.flags ?? [],
        editDistance: wordEditDistance(row.draftText, text),
      })
      .where(eq(schema.applicationAnswer.id, row.id))
      .run();

    if (ctx) saveApproved(row.questionText, text, ctx.company);

    db.insert(schema.applicationEvent)
      .values({
        id: ulid(),
        applicationId: row.applicationId,
        type: 'answer_approved',
        payload: { answerId: row.id, question: row.questionText },
      })
      .run();

    const updated = db
      .select()
      .from(schema.applicationAnswer)
      .where(eq(schema.applicationAnswer.id, row.id))
      .all()[0]!;
    return answerPayload(updated);
  });

  app.post<{ Params: { id: string } }>('/api/answers/:id/unapprove', async (req, reply) => {
    db.update(schema.applicationAnswer)
      .set({ approvedAt: null })
      .where(eq(schema.applicationAnswer.id, req.params.id))
      .run();
    const row = db
      .select()
      .from(schema.applicationAnswer)
      .where(eq(schema.applicationAnswer.id, req.params.id))
      .all()[0];
    if (!row) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such answer.' } });
    }
    return answerPayload(row);
  });

  /** What model access this install has, and why drafting may be unavailable. */
  app.get('/api/model-access', async () => describeAccess());

  /**
   * Runs one real round trip through the configured backend.
   *
   * Worth having as its own endpoint because the CLI path can fail in a way that is not
   * an error: if the prompt never reaches the model, generation still "succeeds" and
   * quietly answers the wrong question. This checks the answer came back.
   */
  app.post('/api/model-access/test', async (_req, reply) => {
    resetBackend();
    resetCliProbe();
    const access = await describeAccess();
    if (access.provider !== 'claude_cli') {
      return { ...access, tested: false, detail: 'Nothing to test for this provider.' };
    }
    const result = await claudeCliSelfTest();
    return reply.code(result.ok ? 200 : 503).send({ ...access, tested: true, ...result });
  });

  app.get('/api/answer-library', async () => ({ entries: listLibrary() }));

  app.delete<{ Params: { id: string } }>('/api/answer-library/:id', async (req, reply) => {
    db.delete(schema.answerTemplate).where(eq(schema.answerTemplate.id, req.params.id)).run();
    return reply.code(204).send();
  });
}

function isBlocking(f: AnswerFlag): boolean {
  return f.type === 'unsupported' || f.type === 'overstated';
}
