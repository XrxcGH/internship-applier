/**
 * Profile persistence with field-level encryption — see docs/03 and docs/10.
 *
 * The encrypted-column list lives here, in one place, so adding a sensitive field is a
 * one-line change and can't be forgotten at a call site.
 */
import { eq } from 'drizzle-orm';
import { z, ZodError } from 'zod';
import {
  Availability,
  CandidateProfile,
  LocationPrefs,
  Preferences,
  WorkAuthorization,
} from '@ia/shared';
import { db, schema } from '../../infra/db/client';
import { decryptField, encryptField } from '../../infra/crypto/fieldCrypto';
import { deriveProfile } from '../ingestion/deriveFields';
import { logger } from '../../infra/logger';

/**
 * Encrypted at rest. Mirrors the 🔒 markers in docs/03-data-model.md.
 * Exported so a test can assert the stored row really is encrypted, rather than
 * trusting that `encryptRow` below stayed in sync with this list.
 */
export const ENCRYPTED_COLUMNS = [
  'fullName',
  'pronouns',
  'email',
  'phone',
  'dateOfBirth',
  'address',
] as const;

type Row = typeof schema.profile.$inferSelect;

function encryptRow(p: CandidateProfile): typeof schema.profile.$inferInsert {
  const aad = p.id;
  const enc = (v: string | null | undefined) => (v == null ? null : encryptField(v, aad));

  return {
    id: p.id,
    fullName: enc(p.fullName) ?? '',
    pronouns: enc(p.pronouns),
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
    pronouns: dec(row.pronouns),
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
    /**
     * A schema mismatch is not a lost key, and must not be reported as one.
     *
     * The write path is typed but never validated; the read path parses strictly. So a
     * resume with no email (stored as ''), a link written as "linkedin.com/in/x" with no
     * scheme, or a year-only graduation date all store cleanly and then fail to parse on
     * the way back — and this handler told the user their key had changed and their data
     * was unrecoverable, when in fact one field was the wrong shape. Worse, it threw on
     * every GET, so the G1 screen where they would have fixed it could not load either.
     */
    if (err instanceof ZodError) {
      logger.error({ err: err.issues }, 'stored profile does not match the schema');
      const where = err.issues
        .slice(0, 4)
        .map((i) => i.path.join('.') || '(root)')
        .join(', ');
      throw new Error(
        'The stored profile does not match the shape this app expects, so it cannot be ' +
          `loaded. The fields at fault: ${where}. Your data is still encrypted and intact — ` +
          'this is a formatting problem, not a lost key. Re-uploading your resume will ' +
          'rebuild the profile.',
        { cause: err },
      );
    }

    logger.error({ err }, 'could not decrypt the stored profile');
    throw new Error(
      'The stored profile could not be decrypted. This usually means the master key changed ' +
        '(a new OS user, a reset keychain, or a deleted data/.master.key). The profile cannot ' +
        'be recovered without the original key; re-upload your resume to start fresh.',
      { cause: err },
    );
  }
}

/**
 * The stored id and confirmation stamp, without decrypting anything.
 *
 * For callers that only need to keep those two across a save. Going through `getProfile`
 * for them means a row that does not parse takes down the very request that would have
 * replaced it — which is how a single unusable field turned into a tool with no way back
 * in, since re-uploading the resume runs through here first.
 */
export function getProfileHeader(): { id: string; confirmedAt: string | null } | null {
  const row = db
    .select({ id: schema.profile.id, confirmedAt: schema.profile.confirmedAt })
    .from(schema.profile)
    .limit(1)
    .all()[0];
  return row ?? null;
}

export function saveProfile(p: CandidateProfile, now: Date = new Date()): CandidateProfile {
  const existing = db.select({ id: schema.profile.id }).from(schema.profile).limit(1).all();

  // There is one profile row, and its id is both the key every match row points at and the
  // additional authenticated data each encrypted column is sealed with. A save carrying a
  // different id — a hand-rolled PUT /api/profile, or a caller that forgot to pin it —
  // rewrote the primary key of the row it was updating: harmless-looking on a fresh install
  // and a foreign-key error surfaced as a bare 500 the moment any match existed, with the
  // user's own edits lost either way. The stored row keeps the id it was created with.
  const id = existing[0]?.id ?? p.id;
  const next: CandidateProfile = {
    ...p,
    id,
    derived: deriveProfile(p, now),
    updatedAt: now.toISOString(),
  };
  /**
   * Nothing gets onto disk that cannot be read back.
   *
   * The write path was typed and the read path parses strictly, and TypeScript cannot check
   * what a language model produced at runtime — so an email the schema will not take, a
   * project URL with no scheme, an employer whose name came back empty, all stored cleanly
   * and then failed on every subsequent read. The failure surfaced nowhere near its cause
   * and it was not survivable: the G1 screen that would have fixed the field could not load,
   * and neither could the re-upload that was supposed to rebuild the profile.
   *
   * Parsing here moves that to the moment of the bad write, where the caller can report
   * which field was wrong and the user still has a working app. Individual repairs upstream
   * are still worth making — this is the floor, not a substitute for them.
   */
  const parsed = CandidateProfile.safeParse(next);
  if (!parsed.success) {
    const where = parsed.error.issues
      .slice(0, 4)
      .map((i) => i.path.join('.') || '(root)')
      .join(', ');
    logger.error({ err: parsed.error.issues }, 'refusing to store a profile that will not parse');
    throw new Error(
      'This profile cannot be stored, because it could not be read back afterwards. The ' +
        `fields at fault: ${where}. Nothing has been changed.`,
      { cause: parsed.error },
    );
  }

  const row = encryptRow(parsed.data);

  if (existing[0]) {
    db.update(schema.profile).set(row).where(eq(schema.profile.id, existing[0].id)).run();
  } else {
    db.insert(schema.profile).values(row).run();
  }
  return parsed.data;
}

/**
 * Gate G1. Refuses while anything is still flagged for review — the point of the gate is
 * that the user has actually looked at what the extractor produced.
 */
export function confirmProfile(now: Date = new Date()): CandidateProfile {
  const p = getProfile();
  if (!p) {
    // Coded, so the route can tell this apart from the three OTHER things that can go wrong
    // here — a row that will not decrypt, one that will not parse, one that will not store.
    // All four used to arrive at the same hardcoded 404, telling a student with a corrupt
    // profile to upload a resume they had already uploaded.
    const err = new Error('No profile to confirm.');
    (err as Error & { code?: string }).code = 'NOT_FOUND';
    throw err;
  }
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

/**
 * The facts a resume cannot contain, read narrowly so a broken row cannot block a re-upload.
 *
 * `POST /api/resumes/:id/extract` used to carry exactly one field across — the id — and take
 * everything else from a fresh draft. So re-uploading a resume silently discarded the date of
 * birth, the work authorization, the citizenships, the availability window, the role families
 * the student had chosen, every additional work location, and every preference: precisely the
 * six facts G1 exists to collect, none of which a resume can restate, all of them wiped by a
 * button the confirm step offers as "Upload a different resume".
 *
 * Deliberately NOT `getProfile()`. That path parses the whole row, and the reason this route
 * reads only the header is written above its call site: one unusable stored field — a
 * year-only graduation date, a link with no scheme — threw, came back a 502, and made the
 * error's own promise that "re-uploading your resume will rebuild the profile" untrue. So each
 * field here is parsed on its own and a field that will not parse is simply absent, leaving
 * the draft's default in its place. A re-extraction still cannot be blocked by stored data.
 *
 * `locationPrefs.base` is not carried: a resume does state where somebody lives, and the fresh
 * extraction is the newer evidence for it. The rest of that object is the student's own
 * answer and is kept.
 */
/**
 * What a re-extraction carries across.
 *
 * `locationPrefs` is deliberately BASE-LESS — the new resume is the better evidence for where
 * somebody lives — and saying so in the type is what stops the next caller spreading this
 * object over a full `locationPrefs` and losing the base. It was typed as a plain
 * `Partial<CandidateProfile>` with an `as` cast smoothing over the difference, and the shallow
 * merge that followed broke every resume re-upload while the compiler said nothing.
 */
export type KeptFacts = Partial<Omit<CandidateProfile, 'locationPrefs'>> & {
  locationPrefs?: Omit<LocationPrefs, 'base'>;
};

export function getUserEnteredFacts(): KeptFacts | null {
  const row = db
    .select({
      id: schema.profile.id,
      dateOfBirth: schema.profile.dateOfBirth,
      workAuthorization: schema.profile.workAuthorization,
      citizenships: schema.profile.citizenships,
      availability: schema.profile.availability,
      locationPrefs: schema.profile.locationPrefs,
      preferences: schema.profile.preferences,
    })
    .from(schema.profile)
    .limit(1)
    .all()[0];
  if (!row) return null;

  const out: KeptFacts = {};
  /** Keeps a field only if it survives its own schema. One bad field cannot cost the others. */
  // Narrowed to exclude `locationPrefs`, so no future edit can write a full one through the
  // helper and quietly undo the distinction this type exists to make.
  const keep = <K extends keyof Omit<CandidateProfile, 'locationPrefs'>>(
    key: K,
    schemaFor: { safeParse: (v: unknown) => { success: boolean; data?: unknown } },
    raw: unknown,
  ): void => {
    if (raw === null || raw === undefined) return;
    const parsed = schemaFor.safeParse(raw);
    if (parsed.success) out[key] = parsed.data as CandidateProfile[K];
  };

  try {
    // The row id is the additional authenticated data every encrypted column is sealed with.
    const dob =
      row.dateOfBirth == null || row.dateOfBirth === ''
        ? null
        : decryptField(row.dateOfBirth, row.id);
    if (dob) out.dateOfBirth = dob;
  } catch {
    // An undecryptable date of birth is one the user will have to re-enter; it must not stop
    // the other five from surviving, nor the re-extraction itself.
  }
  keep('workAuthorization', WorkAuthorization, row.workAuthorization);
  keep('citizenships', z.array(z.string()), row.citizenships);
  keep('availability', Availability, row.availability);
  keep('preferences', Preferences, row.preferences);

  // The base city comes from the new resume; everything else here the student typed.
  const prefs = LocationPrefs.safeParse(row.locationPrefs);
  if (prefs.success) {
    const { base: _ignored, ...rest } = prefs.data;
    out.locationPrefs = rest;
  }
  return out;
}
