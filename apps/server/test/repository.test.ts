import { beforeEach, describe, expect, it } from 'vitest';
import type { CandidateProfile } from '@ia/shared';
import { db, schema, sqlite } from '../src/infra/db/client';
import { runMigrations } from '../src/infra/db/migrate';
import { isEncrypted } from '../src/infra/crypto/fieldCrypto';
import {
  confirmProfile,
  ENCRYPTED_COLUMNS,
  getProfile,
  getProfileHeader,
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
