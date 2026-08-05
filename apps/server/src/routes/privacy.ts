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
    logger.warn({ paths: result.deletedPaths.length }, 'delete-all completed');

    return {
      ...result,
      message:
        'Everything has been deleted. Restart the app to begin again; it will generate a ' +
        'new encryption key and start from an empty profile.',
    };
  });

  /** What the model calls have cost, from the ledger rather than an estimate. */
  app.get('/api/costs', async () => computeCosts());
}
