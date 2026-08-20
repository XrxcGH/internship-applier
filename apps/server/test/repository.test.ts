import { existsSync, statSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CandidateProfile } from '@ia/shared';
import { config } from '../src/config';
import { db, schema, sqlite } from '../src/infra/db/client';
import { runMigrations } from '../src/infra/db/migrate';
import { isEncrypted } from '../src/infra/crypto/fieldCrypto';
import {
  confirmProfile,
  ENCRYPTED_COLUMNS,
  getProfile,
  getProfileHeader,
  getUserEnteredFacts,
  isProfileConfirmed,
  saveProfile,
} from '../src/core/profile/repository';

const NOW = new Date('2026-08-03T00:00:00Z');

function draft(over: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    id: 'prof_test',
    fullName: 'Eric Dean',
    email: 'eric@example.com',
    phone: '+1 555 0100',
    dateOfBirth: '2006-03-15',
    address: { line1: '12 Elm St', city: 'Boston', region: 'MA', country: 'US' },
    links: { other: [] },
    workAuthorization: { country: 'US', status: 'citizen', needsSponsorship: false },
    citizenships: ['US'],
    education: [
      {
        institution: 'MIT',
        level: 'bachelor',
        startDate: '2024-09',
        endDate: '2028-05',
        coursework: [],
        honors: [],
      },
    ],
    experience: [],
    projects: [],
    skills: [],
    certifications: [],
    languages: [],
    availability: { start: '2027-06-01', end: '2027-08-20', flexible: true },
    locationPrefs: {
      base: { city: 'Boston', region: 'MA', country: 'US' },
      additionalBases: [],
      maxCommuteKm: 50,
      remoteOk: true,
      hybridOk: true,
      relocateTo: [],
    },
    preferences: { companySizes: [], roleFamilies: [], industries: [], excludeCompanies: [] },
    derived: {
      age: null,
      isMinor: false,
      academicLevel: 'none',
      academicYear: null,
      expectedGraduation: null,
      yearsProfessionalExperience: 0,
      seniorityBand: 'entry_intern',
    },
    confirmedAt: null,
    needsReview: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  } as CandidateProfile;
}

beforeEach(() => {
  runMigrations();
  sqlite.prepare('DELETE FROM profile').run();
});

describe('profile repository', () => {
  it('round-trips a profile through encryption', () => {
    saveProfile(draft(), NOW);
    const back = getProfile();
    expect(back?.fullName).toBe('Eric Dean');
    expect(back?.email).toBe('eric@example.com');
    expect(back?.dateOfBirth).toBe('2006-03-15');
    expect(back?.address.city).toBe('Boston');
  });

  /**
   * The point of field-level encryption is that someone reading app.db off disk sees
   * nothing. This asserts against the raw row, not the accessor, so drift between
   * ENCRYPTED_COLUMNS and encryptRow is caught.
   */
  it('stores PII columns as opaque ciphertext', () => {
    saveProfile(draft(), NOW);
    const row = db.select().from(schema.profile).all()[0]!;

    for (const col of ENCRYPTED_COLUMNS) {
      const raw = row[col as keyof typeof row] as string | null;
      if (raw === null || raw === '') continue;
      expect(isEncrypted(raw), `${col} is not encrypted at rest`).toBe(true);
    }

    const dump = JSON.stringify(row);
    expect(dump).not.toContain('Eric Dean');
    expect(dump).not.toContain('eric@example.com');
    expect(dump).not.toContain('2006-03-15');
    expect(dump).not.toContain('12 Elm St');
  });

  /**
   * A row that cannot be read back is not a bad row, it is a dead app. `getProfile` parses
   * strictly, so an unusable value stored here failed on every later read — the G1 screen
   * that would have corrected it, the re-upload the error message recommends, and the PUT a
   * user might have tried by hand. The only remaining exit was deleting all their data.
   */
  it('refuses to store a profile it could not read back', () => {
    saveProfile(draft(), NOW);

    for (const [what, bad] of [
      ['email', draft({ email: 'rosa.dean [at] gmail.com' })],
      [
        'projects.0.url',
        draft({ projects: [{ name: 'P', description: 'd', url: 'github.com/rosa', bullets: [] }] }),
      ],
      [
        'experience.0.organization',
        draft({
          experience: [{ organization: '', title: 'Intern', type: 'internship', bullets: [] }],
        }),
      ],
    ] as const) {
      expect(() => saveProfile(bad, NOW), what).toThrow(new RegExp(what.replace(/\./g, '\\.')));
    }

    // And the profile that was already there is still readable, so there is a way forward.
    expect(getProfile()?.email).toBe('eric@example.com');
  });

  it('reads the stored id and confirmation stamp without decrypting anything', () => {
    expect(getProfileHeader()).toBeNull();
    saveProfile(draft(), NOW);
    expect(getProfileHeader()).toEqual({ id: 'prof_test', confirmedAt: null });
    confirmProfile(NOW);
    expect(getProfileHeader()?.confirmedAt).toBe(NOW.toISOString());
  });

  it('recomputes derived fields on every save', () => {
    const saved = saveProfile(draft(), NOW);
    expect(saved.derived.age).toBe(20);
    expect(saved.derived.academicLevel).toBe('undergrad');
    expect(saved.derived.expectedGraduation).toBe('2028-05');
  });

  describe('gate G1', () => {
    it('refuses to confirm while fields still need review', () => {
      saveProfile(draft({ needsReview: ['dateOfBirth', 'availability.start'] }), NOW);
      expect(() => confirmProfile(NOW)).toThrow(/need your review/);
      expect(isProfileConfirmed()).toBe(false);
    });

    it('confirms once review is clear', () => {
      saveProfile(draft(), NOW);
      const confirmed = confirmProfile(NOW);
      expect(confirmed.confirmedAt).toBe(NOW.toISOString());
      expect(isProfileConfirmed()).toBe(true);
    });

    it('does not let an ordinary save silently confirm', () => {
      saveProfile(draft(), NOW);
      expect(isProfileConfirmed()).toBe(false);
    });
  });
});

/**
 * What survives a re-upload, and why this reader is narrow.
 *
 * `POST /api/resumes/:id/extract` carried exactly one field across — the id — and took
 * everything else from a fresh draft. So re-uploading a resume silently destroyed the date of
 * birth, the work authorization, the citizenships, the availability window, the role families
 * the student had chosen, every additional work location and every preference: the six facts
 * G1 exists to collect, none of which a resume can restate, all wiped by a control the confirm
 * step offers as "Upload a different resume".
 */
describe('getUserEnteredFacts', () => {
  it('returns null when there is no profile yet', () => {
    expect(getUserEnteredFacts()).toBeNull();
  });

  it('carries the facts a resume cannot contain', () => {
    saveProfile(
      draft({
        dateOfBirth: '2006-03-15',
        workAuthorization: { country: 'US', status: 'citizen', needsSponsorship: false },
        citizenships: ['US'],
        availability: { start: '2027-06-01', end: '2027-08-20', flexible: false },
        preferences: {
          companySizes: [],
          industries: ['robotics'],
          excludeCompanies: ['Acme'],
          roleFamilies: ['robotics'],
        },
        locationPrefs: {
          base: { city: 'Half Moon Bay', region: 'CA', country: 'US' },
          additionalBases: [{ city: 'Los Angeles', region: 'CA', country: 'US', label: 'school' }],
          maxCommuteKm: 50,
          remoteOk: false,
          hybridOk: true,
          relocateTo: ['Seattle'],
        },
      }),
      NOW,
    );

    const kept = getUserEnteredFacts();
    expect(kept?.dateOfBirth).toBe('2006-03-15');
    expect(kept?.workAuthorization).toMatchObject({ status: 'citizen' });
    expect(kept?.citizenships).toEqual(['US']);
    expect(kept?.availability).toMatchObject({ start: '2027-06-01', flexible: false });
    expect(kept?.preferences).toMatchObject({
      roleFamilies: ['robotics'],
      excludeCompanies: ['Acme'],
    });
    expect(kept?.locationPrefs?.additionalBases).toHaveLength(1);
    expect(kept?.locationPrefs?.relocateTo).toEqual(['Seattle']);
    expect(kept?.locationPrefs?.remoteOk).toBe(false);
  });

  it('does NOT carry the home city, which a resume does state', () => {
    // The fresh extraction is the newer evidence for where somebody lives. Everything else in
    // that object is the student's own answer and is kept.
    saveProfile(draft(), NOW);
    expect(getUserEnteredFacts()?.locationPrefs).not.toHaveProperty('base');
  });

  it('survives a column that will not parse, and keeps the rest', () => {
    // The property the header-only read was protecting: no stored value may block a
    // re-extraction. A field is parsed on its own, and one that fails is simply absent, so
    // the draft's default stands in its place rather than the whole request failing.
    saveProfile(draft({ citizenships: ['US'] }), NOW);
    db.update(schema.profile)
      .set({ availability: { start: 'not-a-date', flexible: 'yes' } as never })
      .run();

    const kept = getUserEnteredFacts();
    expect(kept).not.toBeNull();
    expect(kept?.availability).toBeUndefined();
    expect(kept?.citizenships).toEqual(['US']);
    expect(kept?.workAuthorization).toMatchObject({ status: 'citizen' });
  });
});

/**
 * The file itself, not just the columns inside it.
 *
 * Six profile columns are encrypted; the same database also holds every drafted answer in
 * `draft_text` and `final_text`, every writing sample, every posting and the whole application
 * history, none of which is. A student's essay about why they want a job says more about them
 * than their name does, and the name was the part behind the cipher — so the file's own
 * permissions are what actually stand between that content and another account on the machine.
 * better-sqlite3 creates it with the default mode, which under a typical umask is world-readable.
 */
describe('what the database file is readable by', () => {
  it('is owner-only, along with the two WAL sidecars that carry the same bytes', () => {
    // POSIX only: chmod does not model this on Windows, where the file inherits the per-user
    // data directory's ACL instead. Asserting a mode there would fail for a reason that is
    // not a defect.
    if (process.platform === 'win32') return;

    const file = config.paths.database;
    for (const f of [file, `${file}-wal`, `${file}-shm`]) {
      if (!existsSync(f)) continue;
      const mode = statSync(f).mode & 0o777;
      expect({ f, groupOrOther: mode & 0o077 }).toEqual({ f, groupOrOther: 0 });
    }
  });

  it('keeps the data directory owner-only too', () => {
    if (process.platform === 'win32') return;
    const mode = statSync(config.paths.data).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });
});
