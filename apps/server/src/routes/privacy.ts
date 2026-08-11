/**
 * Privacy and cost — docs/10 § User control, docs/11 § M8.
 *
 * Deleting a resume or an answer is irreversible too; the delete endpoint here is the one
 * that takes everything at once — the database, the uploaded files, the browser profile and
 * the encryption key — and leaves nothing to go back to. So it is built to be hard to reach
 * by accident: it requires a typed phrase in the body, it tells the user exactly what will
 * go before they type it, and it says plainly that there is no undo. A DELETE verb on a
 * resource path would have been tidier REST and much easier to fire by mistake.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logger } from '../infra/logger';
import { computeCosts } from '../core/privacy/costs';
import {
  buildExport,
  DELETE_CONFIRMATION,
  deleteEverything,
  describeWhatWillBeDeleted,
  exportFilename,
} from '../core/privacy/export';
import { closeAllRuns } from '../core/filling/run';

const DeleteBody = z.object({ confirm: z.string() });

export async function privacyRoutes(app: FastifyInstance): Promise<void> {
  /** Everything, decrypted, as one file. */
  app.get('/api/privacy/export', async (_req, reply) => {
    const bundle = buildExport();
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="${exportFilename()}"`)
      .send(JSON.stringify(bundle, null, 2));
  });

  /** What would go, so the warning names real numbers rather than saying "your data". */
  app.get('/api/privacy/delete-preview', async () => ({
    items: describeWhatWillBeDeleted(),
    confirmationPhrase: DELETE_CONFIRMATION,
    warning:
      'This removes the database, your uploaded resumes, saved browser sessions, and the ' +
      'encryption key. There is no undo and no copy kept anywhere. Export first if you ' +
      'want to keep any of it.',
  }));

  app.post('/api/privacy/delete-all', async (req, reply) => {
    const parsed = DeleteBody.safeParse(req.body);
    if (!parsed.success || parsed.data.confirm.trim().toLowerCase() !== DELETE_CONFIRMATION) {
      return reply.code(400).send({
        error: {
          code: 'CONFIRMATION_REQUIRED',
          message: `Type "${DELETE_CONFIRMATION}" to confirm. Nothing has been deleted.`,
        },
      });
    }

    // A fill run holds an open browser against a profile directory that is about to be
    // removed. Closing first avoids deleting files out from under a live Chromium.
    await closeAllRuns();

    const result = await deleteEverything();

    /**
     * The message tells the truth about what actually went.
     *
     * `deleteEverything` has always collected a `failed` list — a resume PDF a viewer still
     * has open, a browser profile an orphaned Chromium still holds, a keychain it could not
     * reach — and this route answered "Everything has been deleted… no copy kept anywhere"
     * regardless. On the one endpoint in the app whose entire purpose is that promise, to
     * the one user who has just typed a phrase to make it happen, that is the failure this
     * repo treats as its worst: an operation that did not finish, reported as one that did.
     *
     * The list travels with it, so the screen can name each file rather than leaving the
     * user to guess which of their resumes is still on the disk.
     */
    const failed = result.failed.length;
    logger.warn(
      { paths: result.deletedPaths.length, failed },
      failed > 0 ? 'delete-all finished with failures' : 'delete-all completed',
    );

    return {
      ...result,
      message:
        failed === 0
          ? 'Everything has been deleted. Restart the app to begin again; it will generate ' +
            'a new encryption key and start from an empty profile.'
          : `Most of it has been deleted, but ${String(failed)} ${
              failed === 1 ? 'thing is' : 'things are'
            } still on this machine — they are listed below. Close anything that has them ` +
            'open and delete again. Restart the app either way; it will generate a new ' +
            'encryption key and start from an empty profile.',
    };
  });

  /** What the model calls have cost, from the ledger rather than an estimate. */
  app.get('/api/costs', async () => computeCosts());
}
