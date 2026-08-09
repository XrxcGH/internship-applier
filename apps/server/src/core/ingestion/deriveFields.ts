/**
 * Computes `profile.derived` — see docs/03-data-model.md.
 *
 * Pure and deterministic. Everything downstream (eligibility rules, scoring, filters)
 * keys off these values, so this file takes a clock as a parameter rather than reading
 * one, and it never guesses: anything it cannot establish comes back null.
 */
import type { AcademicLevel, CandidateProfile, DerivedProfile, SeniorityBand } from '@ia/shared';

/**
 * How much each kind of experience counts toward professional experience. Internships and
 * research count at half weight, volunteer and club work at nothing, jobs and freelance in
 * full.
 */
const WEIGHTS: Record<string, number> = {
  job: 1,
  internship: 0.5,
  freelance: 1,
  research: 0.5,
  volunteer: 0,
  club: 0,
};

export function ageFrom(dateOfBirth: string | null, now: Date): number | null {
  if (!dateOfBirth) return null;
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  if (Number.isNaN(dob.getTime())) return null;
  if (dob.getTime() > now.getTime()) return null;

  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

function monthsBetween(startYm: string, endYm: string): number {
  const [sy, sm] = startYm.split('-').map(Number) as [number, number];
  const [ey, em] = endYm.split('-').map(Number) as [number, number];
  return Math.max(0, (ey - sy) * 12 + (em - sm));
}

function toYearMonth(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * The most advanced degree the person is enrolled in or has completed. Ties break
 * toward the higher level, since eligibility phrasing ("enrolled in a Bachelor's")
 * keys off the level being pursued.
 */
const LEVEL_RANK: Record<string, number> = {
  high_school: 1,
  associate: 2,
  bachelor: 3,
  master: 4,
  doctorate: 5,
  other: 0,
};

const LEVEL_TO_ACADEMIC: Record<string, AcademicLevel> = {
  high_school: 'high_school',
  associate: 'undergrad',
  bachelor: 'undergrad',
  master: 'masters',
  doctorate: 'phd',
};

export function deriveAcademicLevel(profile: CandidateProfile): AcademicLevel {
  if (profile.education.length === 0) return 'none';
  let best = profile.education[0]!;
  for (const e of profile.education) {
    if ((LEVEL_RANK[e.level] ?? 0) > (LEVEL_RANK[best.level] ?? 0)) best = e;
  }
  return LEVEL_TO_ACADEMIC[best.level] ?? 'none';
}

/**
 * Expected graduation: the latest end date across education entries. Future dates are
 * expected graduations; a past-only history means they've already graduated and we
 * return the most recent one, which the graduation-window rule then evaluates.
 */
export function deriveExpectedGraduation(profile: CandidateProfile): string | null {
  const ends = profile.education.map((e) => e.endDate).filter((d): d is string => Boolean(d));
  if (ends.length === 0) return null;
  return ends.reduce((a, b) => (a > b ? a : b));
}

/**
 * Which year of an undergraduate program they're in, 1-indexed. Null when not applicable.
 *
 * Only a program that is actually running counts. Taking the first entry that had a start
 * date meant a finished degree kept accruing years after it ended: a bachelor that ran from
 * 2019-09 to 2023-05 read as a seventh-year undergraduate three years after graduation, and
 * that went into the privacy export as a fact about the person. Someone who has finished has
 * no academic year at all.
 */
export function deriveAcademicYear(profile: CandidateProfile, now: Date): number | null {
  const level = deriveAcademicLevel(profile);
  if (level !== 'undergrad' && level !== 'high_school') return null;

  const nowYm = toYearMonth(now);
  const enrolled = profile.education.filter(
    (e) =>
      (e.level === 'bachelor' || e.level === 'associate' || e.level === 'high_school') &&
      e.startDate !== undefined &&
      e.startDate <= nowYm &&
      (e.endDate === undefined || e.endDate >= nowYm),
  );
  if (enrolled.length === 0) return null;

  // Someone finishing an associate while a bachelor's has already started is in the year of
  // the bachelor's, which is the level the rest of the profile reports.
  const current = enrolled.reduce((a, b) =>
    (LEVEL_RANK[b.level] ?? 0) > (LEVEL_RANK[a.level] ?? 0) ? b : a,
  );

  const year = Math.floor(monthsBetween(current.startDate!, nowYm) / 12) + 1;
  return year >= 1 && year <= 8 ? year : null;
}

/** Months covered by a set of [start, end] YYYY-MM spans, with overlaps counted once. */
function unionMonths(spans: Array<[string, string]>): number {
  const sorted = [...spans].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let total = 0;
  let curStart: string | null = null;
  let curEnd = '';
  for (const [s, e] of sorted) {
    if (curStart === null || s > curEnd) {
      if (curStart !== null) total += monthsBetween(curStart, curEnd);
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  if (curStart !== null) total += monthsBetween(curStart, curEnd);
  return total;
}

export function deriveYearsExperience(profile: CandidateProfile, now: Date): number {
  const nowYm = toYearMonth(now);
  let months = 0;
  const counted: Array<[string, string]> = [];
  for (const e of profile.experience) {
    const weight = WEIGHTS[e.type] ?? 0;
    if (weight === 0) continue;
    // No start date, no contribution. Guessing one is how an undated line on a resume
    // turned into decades of experience.
    if (!e.startDate) continue;
    const end = e.endDate ?? nowYm;
    months += monthsBetween(e.startDate, end) * weight;
    counted.push([e.startDate, end]);
  }
  // Concurrent entries do not sum past the calendar. A school-store job beside an Etsy
  // side venture — the standard DECA/FBLA shape — added up to 4.1 years of professional
  // experience for a student whose entire work history spans 26 calendar months, and that
  // figure feeds the experience-ceiling check against "3+ years required" postings.
  // Nobody has more professional experience than time in which to have gained it.
  return Math.round((Math.min(months, unionMonths(counted)) / 12) * 10) / 10;
}

/**
 * Seniority band. Deliberately coarse — it exists to catch "internships" that demand
 * three years of professional experience, not to rank candidates.
 */
export function deriveSeniorityBand(
  academicLevel: AcademicLevel,
  years: number,
  expectedGraduation: string | null,
  now: Date,
  highSchoolEnd: string | null = null,
): SeniorityBand {
  if (academicLevel === 'high_school') return 'pre_college';

  // Still enrolled in high school: dual-enrollment coursework does not put a student in
  // an intern band, whatever level its community-college entry claims.
  if (highSchoolEnd !== null && highSchoolEnd >= toYearMonth(now)) return 'pre_college';

  const graduated = expectedGraduation !== null && expectedGraduation < toYearMonth(now);
  // A "degree" that ended no later than high school did is dual enrollment, not a
  // completed college program. Without this, a community-college entry labelled
  // "associate" outranked the high school for academicLevel, its year-only end date
  // slipped behind the clock, and a 17-year-old high schooler was banded new_grad — the
  // band that tells eligibility they have finished college. A real associate's earned
  // after high school still promotes: its end date is later than the school's.
  const dualEnrollment = highSchoolEnd !== null && highSchoolEnd >= (expectedGraduation ?? '');
  if (graduated && academicLevel !== 'none' && !dualEnrollment) return 'new_grad';
  if (years >= 1) return 'experienced_intern';
  return 'entry_intern';
}

export function deriveProfile(profile: CandidateProfile, now: Date = new Date()): DerivedProfile {
  const age = ageFrom(profile.dateOfBirth, now);
  const academicLevel = deriveAcademicLevel(profile);
  const expectedGraduation = deriveExpectedGraduation(profile);
  const years = deriveYearsExperience(profile, now);
  // The latest high-school end date, for the dual-enrollment guards in the band.
  const highSchoolEnd = profile.education
    .filter((e) => e.level === 'high_school')
    .map((e) => e.endDate)
    .filter((d): d is string => Boolean(d))
    .reduce<string | null>((a, b) => (a !== null && a > b ? a : b), null);

  return {
    age,
    /**
     * Absent DOB is NOT treated as adult. Guardian mode is deferred out of v1 (the user
     * is 18+), but the flag stays correct so the age_minimum rule and any later
     * reinstatement of guardian mode both behave.
     */
    isMinor: age !== null && age < 18,
    academicLevel,
    academicYear: deriveAcademicYear(profile, now),
    expectedGraduation,
    yearsProfessionalExperience: years,
    seniorityBand: deriveSeniorityBand(
      academicLevel,
      years,
      expectedGraduation,
      now,
      highSchoolEnd,
    ),
  };
}
