import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CandidateProfile } from '@ia/shared';
import { db, schema } from '../src/infra/db/client';
import { runMigrations } from '../src/infra/db/migrate';
import {
  getProfile,
  getProfileHeader,
  getUserEnteredFacts,
  saveProfile,
} from '../src/core/profile/repository';

/**
 * Re-uploading a resume over a profile that already exists.
 *
 * `POST /api/resumes/:id/extract` used to carry one field across — the id — so a re-upload
 * destroyed the date of birth, the work authorization, the availability window, the chosen
 * role families and every additional work location: the facts G1 collects, and precisely the
 * ones a resume cannot restate.
 *
 * The repair introduced a worse bug, and no test caught it because the only coverage was of
 * `getUserEnteredFacts` in isolation. `getUserEnteredFacts` returns `locationPrefs` with
 * `base` deliberately removed — the new resume is the better evidence for where someone
 * lives — and the route merged it with a SHALLOW spread, so that base-less object REPLACED
 * the draft's whole `locationPrefs` rather than merging into it. `base` is required by the
 * schema, `saveProfile` parses before it writes, and every re-upload therefore failed with
 * "The fields at fault: locationPrefs.base." The route's own comment promises the opposite:
 * no stored value can block a re-extraction.
 *
 * So these exercise the MERGE, not the reader.
 */

const NOW = new Date('2026-08-20T00:00:00Z');

function stored(): CandidateProfile {
  return {
    id: 'prof_reextract',
    fullName: 'Rosa Alvarez',
    pronouns: null,
    email: 'rosa@example.edu',
    phone: '+1 555 0100',
    dateOfBirth: '2006-03-15',
    address: { city: 'Half Moon Bay', region: 'CA', country: 'US' },
    links: { other: [] },
    workAuthorization: { country: 'US', status: 'citizen', needsSponsorship: false },
    citizenships: ['US'],
    education: [],
    experience: [],
    projects: [],
    skills: [],
    certifications: [],
    languages: [],
    availability: { start: '2027-06-01', end: '2027-08-20', flexible: false },
    locationPrefs: {
      base: { city: 'Half Moon Bay', region: 'CA', country: 'US' },
      additionalBases: [{ city: 'Los Angeles', region: 'CA', country: 'US', label: 'school' }],
      maxCommuteKm: 50,
      remoteOk: false,
      hybridOk: true,
      relocateTo: ['Seattle'],
    },
    preferences: {
      companySizes: [],
      industries: ['robotics'],
      excludeCompanies: ['Acme'],
      roleFamilies: ['robotics'],
    },
    derived: {},
    confirmedAt: null,
    needsReview: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  } as unknown as CandidateProfile;
}

/** What `toDraftProfile` produces from a fresh reading: a new base, and defaults for the rest. */
function freshDraft(): CandidateProfile {
  return {
    ...stored(),
    id: 'prof_fresh',
    fullName: 'Rosa Alvarez',
    dateOfBirth: null,
    workAuthorization: { country: 'US', status: 'unknown', needsSponsorship: false },
    citizenships: [],
    availability: { flexible: true },
    locationPrefs: {
      // The new resume says somewhere else. This is the value that must survive.
      base: { city: 'Austin', region: 'TX', country: 'US' },
      additionalBases: [],
      maxCommuteKm: 50,
      remoteOk: true,
      hybridOk: true,
      relocateTo: [],
    },
    preferences: {
      companySizes: [],
      industries: [],
      excludeCompanies: [],
      roleFamilies: [],
    },
  } as unknown as CandidateProfile;
}

/** Exactly what routes/resumes.ts does, so the merge itself is what is under test. */
function reextract(): CandidateProfile {
  const existing = getProfileHeader();
  const draft = freshDraft();
  const kept = existing ? (getUserEnteredFacts() ?? {}) : {};
  return saveProfile(
    existing
      ? {
          ...draft,
          ...kept,
          locationPrefs: { ...draft.locationPrefs, ...(kept.locationPrefs ?? {}) },
          id: existing.id,
        }
      : draft,
    NOW,
  );
}

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  db.delete(schema.profile).run();
});

describe('re-extracting a resume over an existing profile', () => {
  it('succeeds at all', () => {
    // The regression this file exists for: the save threw, so re-uploading a resume answered
    // 502 and the student could not replace their resume by any route at all.
    saveProfile(stored(), NOW);
    expect(() => reextract()).not.toThrow();
  });

  it('takes the home city from the NEW resume', () => {
    // The one location fact a resume genuinely restates, and the reason `base` is stripped
    // from what gets carried across.
    saveProfile(stored(), NOW);
    expect(reextract().locationPrefs.base.city).toBe('Austin');
  });

  it('keeps every fact a resume cannot contain', () => {
    saveProfile(stored(), NOW);
    const after = reextract();
    expect(after.dateOfBirth).toBe('2006-03-15');
    expect(after.workAuthorization.status).toBe('citizen');
    expect(after.citizenships).toEqual(['US']);
    expect(after.availability).toMatchObject({ start: '2027-06-01', flexible: false });
    expect(after.preferences.roleFamilies).toEqual(['robotics']);
    expect(after.preferences.excludeCompanies).toEqual(['Acme']);
  });

  it('keeps the rest of locationPrefs, which the student typed', () => {
    // The half of that object that is NOT the base: additional places they work from, where
    // they would move to, and whether they will take remote work.
    saveProfile(stored(), NOW);
    const prefs = reextract().locationPrefs;
    expect(prefs.additionalBases).toHaveLength(1);
    expect(prefs.additionalBases[0]?.city).toBe('Los Angeles');
    expect(prefs.relocateTo).toEqual(['Seattle']);
    expect(prefs.remoteOk).toBe(false);
  });

  it('keeps the id, so history and foreign keys survive', () => {
    saveProfile(stored(), NOW);
    expect(reextract().id).toBe('prof_reextract');
    expect(getProfile()?.id).toBe('prof_reextract');
  });

  it('takes the draft whole when there is no profile to merge with', () => {
    // First upload: nothing to carry, and nothing to fail on.
    expect(getProfileHeader()).toBeNull();
    const saved = reextract();
    expect(saved.locationPrefs.base.city).toBe('Austin');
    expect(saved.dateOfBirth).toBeNull();
  });
});
