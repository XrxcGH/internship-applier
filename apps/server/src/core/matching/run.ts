/**
 * Matching orchestration — extract requirements, evaluate eligibility, score, persist.
 *
 * Requirements are cached per posting: they depend only on the job description, so a
 * profile edit re-runs eligibility and scoring without paying for extraction again.
 */
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { ConfirmedProfile, JobRequirement } from '@ia/shared';
import { db, schema } from '../../infra/db/client';
import { logger } from '../../infra/logger';
import { getProfile } from '../profile/repository';
import { evaluateEligibility, type PostingFacts } from './eligibility';
import { extractRequirements } from './extractRequirements';
import { buildRationale } from './rationale';
import { scoreMatch } from './score';

export interface MatchRunSummary {
  runId: string;
  postingsConsidered: number;
  matched: number;
  eligible: number;
  unknown: number;
  ineligible: number;
  requirementsExtracted: number;
  requirementsDropped: number;
  usedModel: boolean;
  errors: string[];
}

type PostingRow = typeof schema.jobPosting.$inferSelect;

function toFacts(row: PostingRow): PostingFacts {
  return {
    id: row.id,
    company: row.company,
    title: row.title,
    isOpen: row.isOpen,
    closesAt: row.closesAt,
    locations: (row.locations as PostingFacts['locations']) ?? [],
    workArrangement: row.workArrangement,
    term: (row.term as PostingFacts['term']) ?? { season: null, year: null },
  };
}

function loadRequirements(postingId: string): JobRequirement[] {
  return db
    .select()
    .from(schema.jobRequirement)
    .where(eq(schema.jobRequirement.postingId, postingId))
    .all()
    .map((r) => ({
      id: r.id,
      postingId: r.postingId,
      kind: r.kind,
      operator: r.operator,
      value: r.value,
      necessity: r.necessity,
      sourceQuote: r.sourceQuote,
      // Stored as an integer percentage to keep the column typed.
      confidence: r.confidence / 100,
    })) as JobRequirement[];
}

function saveRequirements(postingId: string, reqs: JobRequirement[]): void {
  db.delete(schema.jobRequirement).where(eq(schema.jobRequirement.postingId, postingId)).run();
  for (const r of reqs) {
    db.insert(schema.jobRequirement)
      .values({
        id: r.id,
        postingId,
        kind: r.kind,
        operator: r.operator,
        value: r.value,
        necessity: r.necessity,
        sourceQuote: r.sourceQuote,
        confidence: Math.round(r.confidence * 100),
      })
      .run();
  }
}

export async function runMatching(
  opts: { limit?: number; reextract?: boolean; useModel?: boolean; now?: Date } = {},
): Promise<MatchRunSummary> {
  const profile = getProfile();
  if (!profile?.confirmedAt) {
    throw Object.assign(new Error('Profile is not confirmed (gate G1).'), {
      code: 'PROFILE_NOT_CONFIRMED',
    });
  }
  const confirmed = profile as ConfirmedProfile;
  const now = opts.now ?? new Date();

  const postings = db
    .select()
    .from(schema.jobPosting)
    .limit(opts.limit ?? 500)
    .all();

  const summary: MatchRunSummary = {
    runId: ulid(),
    postingsConsidered: postings.length,
    matched: 0,
    eligible: 0,
    unknown: 0,
    ineligible: 0,
    requirementsExtracted: 0,
    requirementsDropped: 0,
    usedModel: false,
    errors: [],
  };

  for (const row of postings) {
    try {
      let requirements = loadRequirements(row.id);

      if (requirements.length === 0 || opts.reextract) {
        const extracted = await extractRequirements(row.id, row.descriptionText, {
          useModel: opts.useModel,
        });
        saveRequirements(row.id, extracted.requirements);
        requirements = extracted.requirements;
        summary.requirementsExtracted += extracted.requirements.length;
        summary.requirementsDropped += extracted.dropped.length;
        summary.usedModel ||= extracted.usedModel;
      }

      const facts = toFacts(row);
      const outcome = evaluateEligibility({
        profile: confirmed,
        posting: facts,
        requirements,
        now,
      });

      const score = scoreMatch({
        profile: confirmed,
        posting: {
          ...facts,
          descriptionText: row.descriptionText,
          compensation: row.compensation as Record<string, unknown> | null,
          applyEffort: row.applyEffort as {
            steps: number;
            essayCount: number;
            estMinutes: number;
          } | null,
          positionType: row.positionType,
        },
        requirements,
      });

      const rationale = buildRationale({
        company: row.company,
        title: row.title,
        eligibility: outcome.eligibility,
        rules: outcome.rules,
        score,
      });

      const existing = db
        .select({ id: schema.match.id })
        .from(schema.match)
        .where(eq(schema.match.postingId, row.id))
        .all();

      const values = {
        postingId: row.id,
        profileId: confirmed.id,
        eligibility: outcome.eligibility,
        rules: outcome.rules,
        blockers: outcome.blockers,
        score: score.score,
        breakdown: { ...score.breakdown, notes: score.notes },
        rationale,
        computedAt: now.toISOString(),
      };

      if (existing[0]) {
        db.update(schema.match).set(values).where(eq(schema.match.id, existing[0].id)).run();
      } else {
        db.insert(schema.match)
          .values({ id: ulid(), ...values })
          .run();
      }

      summary.matched++;
      summary[outcome.eligibility === 'ineligible' ? 'ineligible' : outcome.eligibility]++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.errors.push(`${row.company} — ${row.title}: ${message}`);
      logger.warn({ err, postingId: row.id }, 'matching failed for posting');
    }
  }

  logger.info(
    {
      runId: summary.runId,
      matched: summary.matched,
      eligible: summary.eligible,
      unknown: summary.unknown,
      ineligible: summary.ineligible,
    },
    'matching run complete',
  );
  return summary;
}
