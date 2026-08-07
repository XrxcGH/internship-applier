import type { FastifyInstance } from 'fastify';
import { CandidateProfile } from '@ia/shared';
import {
  confirmProfile,
  getProfile,
  getProfileHeader,
  saveProfile,
} from '../core/profile/repository';
import { dismissalRefusal } from '../core/profile/reviewFlags';

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
    //
    // Read through the header rather than the whole profile: only `confirmedAt` is wanted,
    // and decrypting-and-parsing the stored row to get it made this route fail on exactly
    // the rows it exists to repair. One field the schema will not take — a year-only
    // graduation date, a link with no scheme — and the PUT carrying the correction threw on
    // the way IN, before it had looked at the body, so the profile could be neither fixed
    // nor replaced.
    const existing = getProfileHeader();
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

    // A flag is dismissible only where there is nowhere to answer it. This endpoint used to
    // drop whichever flag it was handed no matter what the field held, so a field with a
    // control of its own could be marked reviewed while still empty — one call on
    // `dateOfBirth` and G1 confirmed a profile with no date of birth in it. The wizard hides
    // its button for those paths, but a rule that lives only in the client is a suggestion.
    const refusal = dismissalRefusal(p, target);
    if (refusal) {
      return reply.code(409).send({ error: { code: 'ANSWER_REQUIRED', message: refusal } });
    }

    return saveProfile({ ...p, needsReview: p.needsReview.filter((f) => f !== target) });
  });
}
