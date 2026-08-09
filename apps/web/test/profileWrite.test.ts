import { CandidateProfile } from '@ia/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearReviewFlag, saveProfile } from '../src/lib/api';
import { clearToken } from '../src/lib/session';

/**
 * What a profile write costs at G3, kept rather than parsed away.
 *
 * PUT /api/profile and POST /api/profile/reviewed/:path both answer with the saved profile
 * PLUS `withdrawnApprovals` (apps/server/src/routes/profile.ts:224 and :283) — the answers whose
 * G3 approval that write invalidated. The client read it off the wire and dropped it one line
 * later, because `.then(CandidateProfile.parse)` is a Zod object parse and an object parse
 * strips unknown keys. The student went on believing an answer was approved after the app had
 * un-approved it, and found out at G4 when the fill refused.
 *
 * `fetch` is stubbed with the exact body those two routes send rather than booting a server:
 * what is under test is the client's reading of a response shape, and a stub can hold that
 * shape still while the sweep itself is covered on the server side.
 */

const profile = CandidateProfile.parse({
  id: 'p1',
  fullName: 'Ada Ruiz',
  email: 'ada@example.com',
  dateOfBirth: '2008-03-04',
  locationPrefs: { base: { city: 'Austin', region: 'TX' } },
  workAuthorization: { status: 'citizen', needsSponsorship: false },
  availability: { start: '2027-06-01', end: '2027-08-15' },
  education: [
    {
      institution: 'Sample High School',
      level: 'high_school',
      endDate: '2026-06',
      gpa: { value: 3.9, scale: 4 },
    },
  ],
  derived: {
    age: 18,
    isMinor: false,
    academicLevel: 'high_school',
    academicYear: 4,
    expectedGraduation: '2026-06',
    yearsProfessionalExperience: 0,
    seniorityBand: 'pre_college',
  },
  createdAt: '2026-08-09T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
});

const withdrawnApprovals = [
  {
    answerId: 'ans1',
    applicationId: 'app1',
    question: 'Why do you want this internship?',
    claims: [
      {
        claim: 'I designed the intake mechanism in Onshape.',
        reason: '"Onshape" does not appear anywhere on your profile.',
      },
    ],
  },
];

const realFetch = globalThis.fetch;

/** Answers /api/session with a token and everything else with `body`. */
function stubFetch(body: unknown): void {
  globalThis.fetch = ((url: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(url === '/api/session' ? { token: 't' } : body),
    })) as unknown as typeof fetch;
}

beforeEach(() => {
  // The token is cached in a module-level promise, and it was fetched through whichever stub
  // was installed at the time.
  clearToken();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('saveProfile', () => {
  it('keeps the approvals the save withdrew', async () => {
    stubFetch({ ...profile, withdrawnApprovals });
    const saved = await saveProfile(profile);
    expect(saved.profile.id).toBe('p1');
    expect(saved.withdrawnApprovals).toEqual(withdrawnApprovals);
  });

  it('reports nothing when the save cost nothing', async () => {
    stubFetch({ ...profile, withdrawnApprovals: [] });
    expect((await saveProfile(profile)).withdrawnApprovals).toEqual([]);
  });

  it('reports nothing when the field is absent, rather than throwing', async () => {
    // An unconfirmed profile cannot have produced an approval, and a write against one is
    // answered without the field. A client that required it would fail the first save of a
    // brand-new profile, which is every user's first save.
    stubFetch(profile);
    expect((await saveProfile(profile)).withdrawnApprovals).toEqual([]);
  });

  it('still parses the profile itself', async () => {
    stubFetch({ ...profile, email: 12 });
    await expect(saveProfile(profile)).rejects.toThrow();
  });

  it('is why the widening was needed: an object parse drops the key', () => {
    // The behaviour this file guards against coming back. `.then(CandidateProfile.parse)` was
    // the whole of the old client, and this is what it did with the half of the answer that
    // is not a profile.
    const parsed = CandidateProfile.parse({ ...profile, withdrawnApprovals }) as unknown as {
      withdrawnApprovals?: unknown;
    };
    expect(parsed.withdrawnApprovals).toBeUndefined();
  });
});

describe('clearReviewFlag', () => {
  it('keeps them too, because that route writes and sweeps as well', async () => {
    // "I have checked this" saves and then clears a flag. Reading the list off only the first
    // call would miss a withdrawal the second one caused.
    stubFetch({ ...profile, withdrawnApprovals });
    const cleared = await clearReviewFlag('education.0.gpa');
    expect(cleared.profile.id).toBe('p1');
    expect(cleared.withdrawnApprovals).toEqual(withdrawnApprovals);
  });
});
