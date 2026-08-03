/**
 * Profile persistence with field-level encryption — see docs/03 and docs/10.
 *
 * The encrypted-column list lives here, in one place, so adding a sensitive field is a
 * one-line change and can't be forgotten at a call site.
 */
import { eq } from 'drizzle-orm';
import { CandidateProfile } from '@ia/shared';
import { db, schema } from '../../infra/db/client';
import { decryptField, encryptField } from '../../infra/crypto/fieldCrypto';
import { deriveProfile } from '../ingestion/deriveFields';
import { logger } from '../../infra/logger';

/**
 * Encrypted at rest. Mirrors the 🔒 markers in docs/03-data-model.md.
 * Exported so a test can assert the stored row really is encrypted, rather than
 * trusting that `encryptRow` below stayed in sync with this list.
 */
export const ENCRYPTED_COLUMNS = ['fullName', 'email', 'phone', 'dateOfBirth', 'address'] as const;

type Row = typeof schema.profile.$inferSelect;

function encryptRow(p: CandidateProfile): typeof schema.profile.$inferInsert {
  const aad = p.id;
  const enc = (v: string | null | undefined) => (v == null ? null : encryptField(v, aad));

  return {
    id: p.id,
    fullName: enc(p.fullName) ?? '',
    email: enc(p.email) ?? '',
    phone: enc(p.phone),
    dateOfBirth: enc(p.dateOfBirth),
    address: enc(JSON.stringify(p.address)),
    links: p.links,
    workAuthorization: p.workAuthorization,
    citizenships: p.citizenships,
    education: p.education,
    experience: p.experience,
    projects: p.projects,
    skills: p.skills,
    certifications: p.certifications,
    languages: p.languages,
    availability: p.availability,
    locationPrefs: p.locationPrefs,
    preferences: p.preferences,
    derived: p.derived,
    confirmedAt: p.confirmedAt,
    needsReview: p.needsReview,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function decryptRow(row: Row): CandidateProfile {
  const aad = row.id;
  const dec = (v: string | null) => (v == null || v === '' ? null : decryptField(v, aad));

  const address = dec(row.address as string | null);

  return CandidateProfile.parse({
    id: row.id,
    fullName: dec(row.fullName) ?? '',
    email: dec(row.email) ?? '',
    phone: dec(row.phone) ?? undefined,
    dateOfBirth: dec(row.dateOfBirth),
    address: address ? JSON.parse(address) : { country: 'US' },
    links: row.links ?? { other: [] },
    workAuthorization: row.workAuthorization,
    citizenships: row.citizenships ?? [],
    education: row.education ?? [],
    experience: row.experience ?? [],
    projects: row.projects ?? [],
    skills: row.skills ?? [],
    certifications: row.certifications ?? [],
    languages: row.languages ?? [],
    availability: row.availability,
    locationPrefs: row.locationPrefs,
    preferences: row.preferences,
    derived: row.derived,
    confirmedAt: row.confirmedAt,
    needsReview: row.needsReview ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export function getProfile(): CandidateProfile | null {
  const rows = db.select().from(schema.profile).limit(1).all();
  const row = rows[0];
  if (!row) return null;
  try {
    return decryptRow(row);
  } catch (err) {
    logger.error({ err }, 'could not decrypt the stored profile');
    throw new Error(
      'The stored profile could not be decrypted. This usually means the master key changed ' +
        '(a new OS user, a reset keychain, or a deleted data/.master.key). The profile cannot ' +
        'be recovered without the original key; re-upload your resume to start fresh.',
      { cause: err },
    );
  }
}

export function saveProfile(p: CandidateProfile, now: Date = new Date()): CandidateProfile {
  const next: CandidateProfile = {
    ...p,
    derived: deriveProfile(p, now),
    updatedAt: now.toISOString(),
  };
  const row = encryptRow(next);
  const existing = db.select({ id: schema.profile.id }).from(schema.profile).limit(1).all();

  if (existing[0]) {
    db.update(schema.profile).set(row).where(eq(schema.profile.id, existing[0].id)).run();
  } else {
    db.insert(schema.profile).values(row).run();
  }
  return next;
}

/**
 * Gate G1. Refuses while anything is still flagged for review — the point of the gate is
 * that the user has actually looked at what the extractor produced.
 */
export function confirmProfile(now: Date = new Date()): CandidateProfile {
  const p = getProfile();
  if (!p) throw new Error('No profile to confirm.');
  if (p.needsReview.length > 0) {
    const err = new Error(
      `${p.needsReview.length} field(s) still need your review before this can be confirmed.`,
    );
    (err as Error & { code?: string }).code = 'PROFILE_INCOMPLETE';
    throw err;
  }
  return saveProfile({ ...p, confirmedAt: now.toISOString() }, now);
}

export function isProfileConfirmed(): boolean {
  const rows = db.select({ confirmedAt: schema.profile.confirmedAt }).from(schema.profile).all();
  return rows.some((r) => r.confirmedAt !== null);
}
