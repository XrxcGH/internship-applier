import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { config } from '../config';
import { db, schema } from '../infra/db/client';
import { encryptField } from '../infra/crypto/fieldCrypto';
import { hasApiKey } from '../infra/llm/client';
import { describeAccess } from '../infra/llm';
import { extractText, mimeFromFilename, SUPPORTED_MIME } from '../core/ingestion/extractText';
import { extractResume } from '../core/ingestion/extractProfile';
import { toDraftProfile } from '../core/ingestion/toProfile';
import { getProfile, saveProfile } from '../core/profile/repository';
import { logger } from '../infra/logger';

const MAX_BYTES = 12 * 1024 * 1024;

export async function resumeRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/resumes', async (req, reply) => {
    const file = await req.file({ limits: { fileSize: MAX_BYTES } });
    if (!file) {
      return reply
        .code(400)
        .send({ error: { code: 'VALIDATION_FAILED', message: 'No file in the request.' } });
    }

    const mime = SUPPORTED_MIME.has(file.mimetype)
      ? file.mimetype
      : mimeFromFilename(file.filename);

    if (!SUPPORTED_MIME.has(mime)) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: `Unsupported file type. Accepted: PDF, DOCX, TXT, Markdown.`,
        },
      });
    }

    const bytes = await file.toBuffer();
    const id = ulid();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const stored = path.join(config.paths.resumes, `${id}${path.extname(file.filename) || ''}`);

    await mkdir(config.paths.resumes, { recursive: true });
    await writeFile(stored, bytes, { mode: 0o600 });

    const text = await extractText(stored, mime).catch((err: unknown) => {
      logger.warn({ err }, 'local text extraction failed; will rely on the model');
      return null;
    });

    db.insert(schema.resumeDocument)
      .values({
        id,
        filename: file.filename,
        path: encryptField(stored, id),
        mime,
        bytes: bytes.byteLength,
        sha256,
        rawText: text ? encryptField(text, id) : null,
        // Primary when nothing else claims it — not merely when the table is empty.
        // That older test left the app with no primary at all after the primary was
        // deleted, and no later upload could ever become one.
        isPrimary: !db
          .select()
          .from(schema.resumeDocument)
          .all()
          .some((r) => r.isPrimary),
      })
      .run();

    return reply.code(201).send({ documentId: id, filename: file.filename, mime, sha256 });
  });

  app.get('/api/resumes', async () => {
    return db
      .select({
        id: schema.resumeDocument.id,
        filename: schema.resumeDocument.filename,
        mime: schema.resumeDocument.mime,
        bytes: schema.resumeDocument.bytes,
        isPrimary: schema.resumeDocument.isPrimary,
        createdAt: schema.resumeDocument.createdAt,
      })
      .from(schema.resumeDocument)
      .all();
  });

  /**
   * Runs extraction and produces a DRAFT profile. Nothing downstream can read it until
   * the user confirms at gate G1.
   */
  app.post<{ Params: { id: string } }>('/api/resumes/:id/extract', async (req, reply) => {
    /**
     * Reading a resume is the one call that does not go through the backend abstraction:
     * core/ingestion/extractProfile talks to the Anthropic SDK directly, so an API key is
     * genuinely required here even on a machine where the Claude Code CLI is installed and
     * drafting works perfectly.
     *
     * The refusal has to say that, because the rest of the app does not. A CLI user sees a
     * model-access screen reporting "connected" with no limitations, uploads a resume, and
     * is told to "Add one in Settings" — where there is no key field. With no extraction
     * there is no profile, with no profile there is no G1 confirmation, and everything
     * downstream is gated on that, so the whole tool stops with a sentence that cannot be
     * acted on. Naming the file to edit is the least this can do until extraction moves
     * onto the same seam as drafting.
     */
    if (!hasApiKey()) {
      const access = await describeAccess();
      const cliNote =
        access.provider === 'claude_cli'
          ? 'The Claude Code CLI is set up and covers answer drafting, but it cannot read a ' +
            'resume yet — that call still goes to the Anthropic API. '
          : '';
      return reply.code(400).send({
        error: {
          code: 'NO_MODEL_ACCESS',
          message:
            `${cliNote}Reading a resume needs an Anthropic API key. Set ANTHROPIC_API_KEY in ` +
            'the .env file at the root of this repository and restart the server; Settings ' +
            'has no field for it yet. Everything else — matching, eligibility, the writing ' +
            'checks — works without one.',
        },
      });
    }

    const rows = db
      .select()
      .from(schema.resumeDocument)
      .where(eq(schema.resumeDocument.id, req.params.id))
      .all();
    const doc = rows[0];
    if (!doc) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such document.' } });
    }

    const { decryptField } = await import('../infra/crypto/fieldCrypto');
    const filePath = decryptField(doc.path, doc.id);
    const text = doc.rawText ? decryptField(doc.rawText, doc.id) : undefined;

    try {
      const extraction = await extractResume({ path: filePath, mime: doc.mime, text });
      const existing = getProfile();
      const draft = toDraftProfile(extraction);
      // Re-extraction keeps the existing id so history and foreign keys survive.
      const saved = saveProfile(existing ? { ...draft, id: existing.id } : draft);
      return { profile: saved, needsReview: saved.needsReview };
    } catch (err) {
      logger.error({ err }, 'resume extraction failed');
      return reply.code(502).send({
        error: { code: 'INTERNAL', message: (err as Error).message },
      });
    }
  });
  /** Which resume gets attached to applications by default. */
  app.post<{ Params: { id: string } }>('/api/resumes/:id/primary', async (req, reply) => {
    const row = db
      .select({ id: schema.resumeDocument.id })
      .from(schema.resumeDocument)
      .where(eq(schema.resumeDocument.id, req.params.id))
      .all()[0];
    if (!row) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such document.' } });
    }
    db.update(schema.resumeDocument).set({ isPrimary: false }).run();
    db.update(schema.resumeDocument)
      .set({ isPrimary: true })
      .where(eq(schema.resumeDocument.id, req.params.id))
      .run();
    return { id: req.params.id, isPrimary: true };
  });

  /** Deletes the row AND the file on disk — see docs/10 § User control. */
  app.delete<{ Params: { id: string } }>('/api/resumes/:id', async (req, reply) => {
    const row = db
      .select()
      .from(schema.resumeDocument)
      .where(eq(schema.resumeDocument.id, req.params.id))
      .all()[0];
    if (!row) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such document.' } });
    }
    try {
      const { decryptField } = await import('../infra/crypto/fieldCrypto');
      await rm(decryptField(row.path, row.id), { force: true });
    } catch (err) {
      logger.warn({ err, id: row.id }, 'could not remove resume file; removing the row anyway');
    }
    db.delete(schema.resumeDocument).where(eq(schema.resumeDocument.id, req.params.id)).run();

    /**
     * Something has to be primary if anything is left.
     *
     * Deleting the primary used to leave none, and the fill run then had no resume to
     * attach — reported as a skipped field with "No file to attach", which is honest but
     * easy to miss on a form with thirty rows. The most recent survivor is promoted.
     */
    if (row.isPrimary) {
      const next = db
        .select()
        .from(schema.resumeDocument)
        .orderBy(desc(schema.resumeDocument.createdAt))
        .all()[0];
      if (next) {
        db.update(schema.resumeDocument)
          .set({ isPrimary: true })
          .where(eq(schema.resumeDocument.id, next.id))
          .run();
      }
    }

    return reply.code(204).send();
  });
}
