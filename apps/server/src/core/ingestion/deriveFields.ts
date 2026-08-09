/**
 * Computes `profile.derived` — see docs/03-data-model.md.
 *
 * Pure and deterministic. Everything downstream (eligibility rules, scoring, filters)
 * keys off these values, so this file takes a clock as a parameter rather than reading
 * one, and it never guesses: anything it cannot establish comes back null.
 */
import type {
  AcademicLevel,
  CandidateProfile,
  DerivedProfile,
  EducationEntry,
  SeniorityBand,
} from '@ia/shared';

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

/**
 * Nobody has been working since before they could hold a job.
 *
 * `unionMonths` below stops concurrent entries summing past the calendar, but a single
 * entry never overlaps itself, so one wrong start date walks straight through it: a
 * fifteen-year-old whose only job line read "2010-01 to 2026-06" — one digit wrong, or a
 * PDF that ran two resume lines together — derived 16.4 years of professional experience
 * and cleared a "3+ years required" posting with a green tick beside it. Twelve is
 * deliberately low: this population babysits, tutors and works school stores, and the cap
 * only has to make an impossible figure impossible, not police a plausible one.
 */
const MIN_WORKING_AGE_YEARS = 12;

/**
 * How long an open-ended high-school entry keeps reading as an enrolment.
 *
 * "Lincoln High School, Aug 2023 - Present" is what extraction emits for a programme in
 * progress, and it has to be treated as one. But an adult who simply never wrote down when
 * they left school produces the identical shape, and reading that as ongoing would pin a
 * 28-year-old with a finished bachelor's at academicLevel `high_school` and hard-fail them
 * on every degree requirement. Four years of school plus a year of slack: past that, an
 * open-ended high-school line is a missing date rather than a desk someone is sitting at.
 */
const MAX_HIGH_SCHOOL_MONTHS = 60;

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

/**
 * Is the student sitting in this high school as of `now`?
 *
 * A stated end date in the future says so outright. An ABSENT end date says so too: it is
 * exactly what the extractor emits for "Lincoln High School, Aug 2023 - Present". Reading
 * that as "no date here, skip this entry" is what let a 17-year-old College-Credit-Plus
 * junior be banded new_grad, published with his community college's May-2026 semester as
 * his own graduation date, and then hard-failed on "must be currently enrolled in school"
 * and on every class-of-2028 graduation window, with no override anywhere downstream.
 */
function inHighSchoolNow(e: EducationEntry, nowYm: string): boolean {
  if (e.level !== 'high_school') return false;
  if (e.endDate !== undefined) return e.endDate >= nowYm;
  return (
    e.startDate !== undefined &&
    e.startDate <= nowYm &&
    monthsBetween(e.startDate, nowYm) <= MAX_HIGH_SCHOOL_MONTHS
  );
}

/**
 * The education entries that speak for the level this person is pursuing.
 *
 * College coursework taken WHILE still in high school is dual enrollment, and it does not
 * make its owner an undergraduate. `deriveSeniorityBand` has known that since a community
 * college labelled "associate" banded a 17-year-old new_grad, but `deriveAcademicLevel`
 * never learned it, and academicLevel is the field the education_level eligibility rule
 * reads: the same 16-year-old came back band `pre_college` and level `undergrad`, and a
 * posting saying "must be pursuing a Bachelor's degree" told a high-school junior "Your
 * level (bachelor) meets the requirement" with a green tick beside it.
 *
 * The test is therefore not "is this entry dual enrollment" but "does the resume place this
 * entry AFTER high school". Only the second can be answered from a resume, and anything it
 * cannot answer is set aside: `hasDualEnrollment` turns a set-aside entry into an `unknown`
 * at the education_level rule, and `unknown` blocks nobody.
 *
 * That is cheap, not free, and the bill falls off the centre of this population. A high
 * school line with no dates at all sets aside every college entry beside it, because
 * nothing on the page places them either way — so an ordinary undergraduate who wrote
 * "Central High School" with no years, beside "State U, 2023-09 - 2027-05", reports
 * academicLevel `high_school` and band `pre_college` and gets `unknown` where he would have
 * got `pass`. Deciding it the other way is what green-ticked "Your level (bachelor) meets
 * the requirement" for a 16-year-old College-Credit-Plus junior with the identically shaped
 * resume, so the guess is not available; `unknown` blocks nobody and a green tick does.
 * Only scoring reads `seniorityBand`, and no rule turns either field into a refusal.
 */
function degreeBearing(profile: CandidateProfile, now: Date): EducationEntry[] {
  const highSchools = profile.education.filter((e) => e.level === 'high_school');
  if (highSchools.length === 0) return profile.education;

  const nowYm = toYearMonth(now);
  return profile.education.filter(
    (e) => e.level === 'high_school' || !highSchools.some((h) => mayRunAlongside(e, h, nowYm)),
  );
}

/**
 * Could this entry have been taken alongside high school `h`? Only a resume that positively
 * places it AFTER the school answers no.
 *
 * The version this replaces asked `inHighSchoolNow(h)` first and set every college entry
 * aside while that was true, which needed a DATE on the high school to work at all — and a
 * high-school line with no dates on it is the commonest way a 16-year-old writes his own
 * school down, and exactly what the extractor emits for it. That switched the whole guard
 * off: a College-Credit-Plus junior with "Lincoln High School" and no dates beside "Valley
 * Community College, 2025-09 - 2027-06" derived as `undergrad`, was told "Your level
 * (bachelor) meets the requirement" on a posting demanding a Bachelor's, and was then
 * hard-failed `ineligible` on a class-of-2030 window measured against his community
 * college's semester. Both halves of that, on one profile, from one missing date.
 */
function mayRunAlongside(e: EducationEntry, h: EducationEntry, nowYm: string): boolean {
  if (inHighSchoolNow(h, nowYm)) {
    // The school is still running, so an entry is clear of it only by starting after it
    // ends. Setting aside EVERY entry here instead deleted the university a high-school
    // senior had already written down — "Ohio State, Aug 2027 - May 2031" beside a school
    // finishing June 2027 — published his 2027-06 school date as his graduation, and turned
    // a class-of-2031 posting he plainly matches from pass into "add the programme you are
    // going on to", which he had.
    return !(h.endDate !== undefined && e.startDate !== undefined && e.startDate > h.endDate);
  }

  // The school is over and says when: an entry that outlasts it was not taken inside it.
  if (h.endDate !== undefined) return e.endDate !== undefined && e.endDate <= h.endDate;

  // No end date, and `inHighSchoolNow` has already read it as an enrolment wherever it can.
  // Getting here means either the start is old enough that MAX_HIGH_SCHOOL_MONTHS calls the
  // missing end a missing date — the one reading that says the student HAS left — or there
  // is no usable start date at all, and then nothing on the resume says when this person
  // was in school. Undecidable is not "they left": it is set aside and asked about.
  if (h.startDate === undefined || h.startDate > nowYm) return true;

  // The cap's reading settles entries the resume puts in the PAST, and only those. An entry
  // still running today sits beside a school line that, being open, also claims to be
  // running today, and nothing on the page separates the two: "Lincoln High, Jun 2021 -"
  // beside "Valley CC, Sep 2025 - Jun 2027" is a College-Credit-Plus junior one month past
  // the cap, and reading the school as over promoted him to `undergrad`, green-ticked
  // "must be pursuing a Bachelor's", and refused him a class-of-2030 window on his
  // community college's 2027-06 semester. A finished degree carries no such conflict, so
  // the adult whose "Central High, Sep 2012 -" sits beside a bachelor's completed in
  // 2020-05 still promotes.
  return e.endDate === undefined || e.endDate >= nowYm;
}

/**
 * Does this profile carry college coursework that `degreeBearing` set aside as dual
 * enrollment? The eligibility rules need to know, because "your level is high_school" is
 * the honest derivation for such a student and still not the whole story: whether a
 * community-college transcript counts as pursuing a Bachelor's is a question only the
 * student can answer, so the rule asks rather than passing or refusing them.
 */
export function hasDualEnrollment(profile: CandidateProfile, now: Date): boolean {
  const bearing = new Set(degreeBearing(profile, now));
  return profile.education.some((e) => !bearing.has(e));
}

export function deriveAcademicLevel(profile: CandidateProfile, now: Date): AcademicLevel {
  const entries = degreeBearing(profile, now);
  if (entries.length === 0) return 'none';
  let best = entries[0]!;
  for (const e of entries) {
    if ((LEVEL_RANK[e.level] ?? 0) > (LEVEL_RANK[best.level] ?? 0)) best = e;
  }
  return LEVEL_TO_ACADEMIC[best.level] ?? 'none';
}

/**
 * Expected graduation: the latest end date across the entries that speak for the level.
 * Future dates are expected graduations; a past-only history means they've already
 * graduated and we return the most recent one, which the graduation-window rule evaluates.
 *
 * An entry with NO end date is a programme still running, and nothing on the resume says
 * when it finishes. Dropping such an entry and taking the max of what was left published a
 * finished sibling's past date as the person's graduation, twice over: a dual-enrollment
 * junior still in high school was given his community college's May-2026 semester, and a
 * rising freshman with a bare "Ohio State University" line was given his high school's
 * June-2026 one. Both were then told "you graduated" and hard-failed on active enrolment
 * and on every class-of-2030 window, which is precisely the population this tool exists
 * for. The verifier found the same hole under an ordinary undergraduate whose university
 * line read "Sep 2023 - Present".
 *
 * So an open-ended entry withholds the answer, and `null` is the answer the eligibility
 * rules are built to receive: enrollment and graduation_window each have a purpose-built
 * `unknown` branch that asks the user instead of hiding the posting.
 *
 * The one open entry that cannot withhold anything is one a dated sibling has already
 * settled — an adult who lists "Central High School" with no end date beside a bachelor's
 * completed in 2020-05 has an unarguable graduation date, because high school finished
 * before the degree did, whenever it was. Settling it takes BOTH a STRICTLY higher level
 * and an end date the open entry had not already started past. Rank alone let a finished
 * bachelor speak for a nursing associate begun the year AFTER it: the graduate was
 * published as having graduated 2024-05, and a posting for current students only returned
 * `ineligible` against a programme he is sitting in right now — the same failure this
 * function exists to stop, in the one family a rank test does not reach.
 *
 * "At least as high" reached one family too far, in the same direction. Finishing one
 * bachelor's says nothing whatever about when a second one finishes, so a transfer or
 * double-major student listing "State U 2020-09 - 2024-05" beside "State U 2023-09 -
 * Present" was published as having graduated 2024-05 and hard-failed on active enrolment,
 * while `academicYear: 3` on the same object said he was sitting in the programme. Only a
 * HIGHER level proves the open one is behind it: high school ends before the degree that
 * follows it does. Equal levels prove nothing, so they withhold.
 */
export function deriveExpectedGraduation(profile: CandidateProfile, now: Date): string | null {
  const entries = degreeBearing(profile, now);
  const dated = entries.filter((e) => e.endDate !== undefined);

  const unsettled = entries.some(
    (e) =>
      e.endDate === undefined &&
      !dated.some(
        (d) =>
          (LEVEL_RANK[d.level] ?? 0) > (LEVEL_RANK[e.level] ?? 0) &&
          (e.startDate === undefined || d.endDate! >= e.startDate),
      ),
  );
  if (unsettled || dated.length === 0) return null;

  return dated.map((e) => e.endDate!).reduce((a, b) => (a > b ? a : b));
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
  const level = deriveAcademicLevel(profile, now);
  if (level !== 'undergrad' && level !== 'high_school') return null;

  const nowYm = toYearMonth(now);
  // Dual-enrollment entries are excluded for the same reason they are excluded from the
  // level: a high-school junior in his first community-college term is in year 4 of high
  // school, not year 1 of anything, and reporting "year 1" beside "high_school" would put
  // a contradiction into the privacy export as a fact about the person.
  const enrolled = degreeBearing(profile, now).filter(
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

  // The programme the level speaks for may not have started yet. A senior who has already
  // written down the university he starts in the autumn reports academicLevel `undergrad`
  // while the only thing running is high school, and "year 4" beside "undergrad" says he is
  // a college senior — a statement about the person that is not true and that the privacy
  // export carries verbatim. He is in no year of the level being reported.
  if (level !== 'high_school' && current.level === 'high_school') return null;

  const year = Math.floor(monthsBetween(current.startDate!, nowYm) / 12) + 1;
  // MAX_HIGH_SCHOOL_MONTHS again, as an upper bound this time: "year 6 of high school" is a
  // missing or mistyped start date on an open-ended school line, not a fact about the
  // person, and the privacy export prints whatever lands here as one.
  const ceiling = current.level === 'high_school' ? MAX_HIGH_SCHOOL_MONTHS / 12 : 8;
  return year >= 1 && year <= ceiling ? year : null;
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
  const elapsed = Math.min(months, unionMonths(counted));

  // Nor than working life. See MIN_WORKING_AGE_YEARS: the calendar cap above is computed
  // from the same dates that were wrong, so a single mistyped start date walks through it.
  // With no date of birth on file there is no cap, because inventing an age here would be
  // the same guess in the other direction.
  const age = ageFrom(profile.dateOfBirth, now);
  const workingLife = age === null ? Infinity : Math.max(0, age - MIN_WORKING_AGE_YEARS) * 12;

  return Math.round((Math.min(elapsed, workingLife) / 12) * 10) / 10;
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
  const academicLevel = deriveAcademicLevel(profile, now);
  const expectedGraduation = deriveExpectedGraduation(profile, now);
  const years = deriveYearsExperience(profile, now);
  // The latest high-school end date, for the dual-enrollment guards in the band. A student
  // still in high school now reaches the band as academicLevel `high_school` and is caught
  // by its first line, so this is the second lock on the same door rather than the only
  // one: it still has to catch the student whose high school and whose community-college
  // "degree" both ended last term.
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
