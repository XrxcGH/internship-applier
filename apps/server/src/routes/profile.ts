import type { FastifyInstance } from 'fastify';
import { CandidateProfile } from '@ia/shared';
import { confirmProfile, getProfile, saveProfile } from '../core/profile/repository';

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/profile', async (_req, reply) => {
    const p = getProfile();
    if (!p) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'No profile yet. Upload a resume first.' } });
    }
    return p;
  });

  app.put('/api/profile', async (req, reply) => {
    const parsed = CandidateProfile.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Profile did not match the expected shape.',
          details: { issues: parsed.error.issues },
        },
      });
    }
    // Confirmation is a separate, explicit action — a PUT can never confirm.
    const existing = getProfile();
    return saveProfile({ ...parsed.data, confirmedAt: existing?.confirmedAt ?? null });
  });

  /** Gate G1. */
  app.post('/api/profile/confirm', async (_req, reply) => {
    try {
      return confirmProfile();
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      if (code === 'PROFILE_INCOMPLETE') {
        return reply.code(400).send({
          error: {
            code: 'PROFILE_INCOMPLETE',
            message: (err as Error).message,
            details: { needsReview: getProfile()?.needsReview ?? [] },
          },
        });
      }
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: (err as Error).message } });
    }
  });

  /** Clear one review flag — the UI calls this when the user edits a flagged field. */
  app.post<{ Params: { path: string } }>('/api/profile/reviewed/:path', async (req, reply) => {
    const p = getProfile();
    if (!p) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'No profile yet. Upload a resume first.' } });
    }
    // The router has already decoded this segment, and decoding it a second time was wrong
    // in both directions. A flag containing a percent sign — the extractor writes whatever
    // it read, and "honors.0.top 5%" is a real honour — arrived as `100%off`, threw a
    // URIError out of the handler and came back as a 500 saying the server had broken;
    // since G1 refuses to confirm a profile while any flag is outstanding, that flag could
    // never be cleared and the wizard could not be finished. A flag containing `%2F` was
    // quietly turned into `a/b`, matched nothing, and was left in place just as permanently.
    const target = req.params.path;
    return saveProfile({ ...p, needsReview: p.needsReview.filter((f) => f !== target) });
  });
}
