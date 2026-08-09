/**
 * Maps a ResumeExtraction onto a draft CandidateProfile.
 *
 * Everything the resume cannot tell us — date of birth, work authorization, availability
 * window — is left at a neutral default and added to `needsReview` so gate G1 forces the
 * user to supply it. Guessing any of these would silently corrupt eligibility. Home city and
 * state are the exception: a resume usually does print them, so they arrive as a suggestion
 * and stay flagged until the user has looked at them.
 */
import { z } from 'zod';
import { ulid } from 'ulid';
import type { CandidateProfile, Skill } from '@ia/shared';
import type { ResumeExtraction } from './extractProfile';
import { deriveProfile } from './deriveFields';

/** Facts eligibility depends on that a resume never contains. */
export const REQUIRED_BY_G1 = [
  'dateOfBirth',
  'workAuthorization.status',
  'availability.start',
  'availability.end',
  'locationPrefs.base.city',
  'locationPrefs.base.region',
] as const;

/**
 * A URL the schema will accept, or nothing.
 *
 * Resumes print links the way people read them — "linkedin.com/in/rosa", "github.com/rosa"
 * — and `z.string().url()` rejects both. Stored anyway (nothing validates on write), they
 * made every subsequent read of the profile throw. A missing scheme is the one repair
 * worth making automatically; anything else is dropped rather than guessed at.
 */
function asUrl(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return URL.canParse(candidate) ? candidate : undefined;
}

/**
 * An address the schema will accept, or the empty string it treats as "not known yet".
 *
 * Every other field the extractor produces is either repaired on the way in or flagged for
 * the user; the email address was neither. A resume that prints "rosa.dean [at] gmail.com"
 * to dodge scrapers — or "rosa.dean(at)gmail.com", or a line break landing mid-address —
 * was stored verbatim, and since nothing validates on write, the row only failed on the way
 * back OUT. Every read of the profile threw, including the G1 screen where the address would
 * have been corrected, so the tool was unusable and the one obvious remedy, re-uploading the
 * resume, went through the same failing read first.
 *
 * '' is a legal, meaningful value here: the schema documents it as "no readable address",
 * and `needsReview` below turns it into something G1 refuses to pass until the user types
 * one. Stripping a `mailto:` is mechanical, the same class of repair as adding a missing
 * scheme to a URL. Anything beyond that would be guessing at somebody's address.
 */
const EMAIL = z.string().email();

function asEmail(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/^mailto:/i, '');
  return EMAIL.safeParse(trimmed).success ? trimmed : '';
}

/** A YYYY-MM the schema will accept, or nothing. A year alone does not name a month. */
function asYearMonth(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(raw.trim()) ? raw.trim() : undefined;
}

/** A trailing "USA" on a location line is a country, not a state. */
const US_TAIL = /^(u\.?s\.?a?\.?|united states( of america)?)$/i;

/**
 * Countries named often enough on a resume that "Berlin, Germany" has to be read as a city
 * and a country rather than a city and a state.
 *
 * A two-part line is normally "City, State", so only a name listed here is promoted out of
 * the state slot; anything unrecognised keeps today's reading rather than being guessed at.
 * Names that are also US states — Georgia — are deliberately absent, because "Atlanta,
 * Georgia" is by far the likelier line to meet.
 */
const COUNTRY_NAMES: Record<string, string> = {
  canada: 'Canada',
  mexico: 'Mexico',
  'united kingdom': 'United Kingdom',
  uk: 'United Kingdom',
  'u.k.': 'United Kingdom',
  england: 'United Kingdom',
  scotland: 'United Kingdom',
  wales: 'United Kingdom',
  ireland: 'Ireland',
  germany: 'Germany',
  france: 'France',
  spain: 'Spain',
  portugal: 'Portugal',
  italy: 'Italy',
  netherlands: 'Netherlands',
  belgium: 'Belgium',
  switzerland: 'Switzerland',
  austria: 'Austria',
  sweden: 'Sweden',
  norway: 'Norway',
  denmark: 'Denmark',
  finland: 'Finland',
  poland: 'Poland',
  romania: 'Romania',
  ukraine: 'Ukraine',
  greece: 'Greece',
  turkey: 'Turkey',
  israel: 'Israel',
  india: 'India',
  pakistan: 'Pakistan',
  bangladesh: 'Bangladesh',
  china: 'China',
  japan: 'Japan',
  'south korea': 'South Korea',
  taiwan: 'Taiwan',
  singapore: 'Singapore',
  vietnam: 'Vietnam',
  philippines: 'Philippines',
  indonesia: 'Indonesia',
  malaysia: 'Malaysia',
  thailand: 'Thailand',
  australia: 'Australia',
  'new zealand': 'New Zealand',
  brazil: 'Brazil',
  argentina: 'Argentina',
  chile: 'Chile',
  colombia: 'Colombia',
  peru: 'Peru',
  nigeria: 'Nigeria',
  ghana: 'Ghana',
  kenya: 'Kenya',
  egypt: 'Egypt',
  'south africa': 'South Africa',
  morocco: 'Morocco',
  uae: 'United Arab Emirates',
  'united arab emirates': 'United Arab Emirates',
  'saudi arabia': 'Saudi Arabia',
  qatar: 'Qatar',
  russia: 'Russia',
};

/** The country a trailing part of a location line names, if it names one at all. */
function asCountry(part: string): string | undefined {
  if (US_TAIL.test(part)) return 'US';
  return COUNTRY_NAMES[part.toLowerCase()];
}

/**
 * The candidate's own location line, split into the home city, state and country the
 * profile keeps.
 *
 * The extractor is asked for this on every run and the answer used to be dropped on the
 * floor, so at G1 the user retyped a city the tool had already read off the page. City and
 * state stay in `needsReview`: this is a suggestion to check, not a fact being asserted. A
 * line that is not recognisably "City, State" leaves the state empty rather than inventing
 * one.
 *
 * A country the resume states used to be thrown away and the profile filled in with "US"
 * regardless — so "Berlin, Germany" was stored as somebody living in the state of Germany,
 * in the United States, and the fill engine went on to type "US" into the country field of
 * their applications. That is a wrong fact asserted in the user's name, on a screen that
 * shows no country control for them to correct it on.
 */
function splitLocation(raw: string | null | undefined): {
  city: string;
  region: string;
  country?: string;
} {
  const parts = (raw ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  /**
   * A country is only ever taken from a name we recognise, at any part count.
   *
   * Position alone used to be enough for a third part — "Toronto, ON, Canada" reads that
   * way — but a resume header is not a structured address. "Apt 4, Austin, TX" and
   * "Brooklyn, New York, NY" are equally ordinary, and both stored the state abbreviation
   * as the country. That value goes on to be typed into the Country field of a real
   * application, on a screen with no country control to correct it, so the tool would have
   * asserted "TX" as a country in the user's name.
   *
   * When the trailing part is not a country we know, it stays where it is and the country
   * is left absent — the same refusal to guess the two-part branch already made.
   */
  let country: string | undefined;
  const last = parts[parts.length - 1];
  if (last && parts.length >= 2) {
    country = asCountry(last);
    if (country) parts.pop();
  }

  return { city: parts[0] ?? '', region: parts[1] ?? '', ...(country ? { country } : {}) };
}

export function toDraftProfile(x: ResumeExtraction, now: Date = new Date()): CandidateProfile {
  const ts = now.toISOString();
  const home = splitLocation(x.location);
  const email = asEmail(x.email);

  const skills: Skill[] = x.skills.map((s) => ({
    name: s.name,
    category: s.category,
    // Evidence is attached during confirmation, when experience/project ids are stable.
    evidence: [],
  }));

  const draft: CandidateProfile = {
    id: ulid(),
    fullName: x.fullName ?? '',
    pronouns: x.pronouns ?? null,
    email,
    phone: x.phone ?? undefined,
    dateOfBirth: null,
    address: { country: home.country ?? 'US' },
    links: {
      github: asUrl(x.links.github),
      linkedin: asUrl(x.links.linkedin),
      portfolio: asUrl(x.links.portfolio),
      other: [],
    },
    // This is the country the authorization question is *about*, not where the user lives:
    // the tool only searches US postings, so the question every posting asks is whether
    // they may work in the US. The answer itself stays 'unknown' and G1 makes them give it.
    workAuthorization: { country: 'US', status: 'unknown', needsSponsorship: false },
    citizenships: [],
    education: x.education.map((e) => ({
      institution: e.institution,
      level: e.level,
      fieldOfStudy: e.fieldOfStudy ?? undefined,
      startDate: asYearMonth(e.startDate),
      endDate: asYearMonth(e.endDate),
      gpa:
        e.gpaValue !== null && e.gpaScale !== null
          ? { value: e.gpaValue, scale: e.gpaScale, weighted: e.gpaWeighted ?? undefined }
          : undefined,
      coursework: e.coursework,
      honors: e.honors,
    })),
    experience: x.experience.map((e) => ({
      organization: e.organization,
      title: e.title,
      type: e.type,
      startDate: asYearMonth(e.startDate),
      endDate: asYearMonth(e.endDate),
      location: e.location ?? undefined,
      bullets: e.bullets,
    })),
    projects: x.projects.map((p) => ({
      name: p.name,
      description: p.description,
      // The schema demands a real URL here for exactly the same reason it does under
      // `links`, and a resume writes a project's address the same way it writes a profile's
      // — "github.com/rosa/parser". Repairing the three under `links` and not this one left
      // half the mechanism working: one bare host name in a projects section still made
      // every read of the profile throw.
      url: asUrl(p.url),
      bullets: p.bullets,
    })),
    skills,
    certifications: x.certifications.map((c) => ({
      name: c.name,
      issuer: c.issuer ?? undefined,
      date: asYearMonth(c.date),
    })),
    languages: x.languages,
    availability: { flexible: true },
    locationPrefs: {
      base: { city: home.city, region: home.region, country: home.country ?? 'US' },
      maxCommuteKm: 50,
      remoteOk: true,
      hybridOk: true,
      relocateTo: [],
    },
    preferences: { companySizes: [], industries: [], excludeCompanies: [] },
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
    needsReview: dedupe([
      ...x.needsReview,
      ...REQUIRED_BY_G1,
      ...(x.fullName ? [] : ['fullName']),
      // Flagged whether the resume had no address at all or had one this app cannot use.
      // From the user's side those are the same thing — the tool does not know how to reach
      // them — and only one of the two used to reach the screen that asks.
      ...(email ? [] : ['email']),
      // Experience duration feeds the seniority band and the experience-ceiling rule, so
      // a start date the extractor could not read — or wrote in a form the schema will
      // not take — has to reach the user rather than be filled in with a guess.
      ...x.experience.flatMap((e, i) =>
        asYearMonth(e.startDate) ? [] : [`experience.${i}.startDate`],
      ),
      ...x.education.flatMap((e, i) =>
        e.endDate && !asYearMonth(e.endDate) ? [`education.${i}.endDate`] : [],
      ),
      // A stated education start date the schema will not take ("2023" alone) used to be
      // dropped in silence, unlike its experience twin: academicYear quietly degraded from
      // a number to null and nobody was asked. Same rule as the endDate above — flag only
      // what was stated but unusable, since a start date absent from the resume is normal.
      ...x.education.flatMap((e, i) =>
        e.startDate && !asYearMonth(e.startDate) ? [`education.${i}.startDate`] : [],
      ),
      // Level "other" is the extraction's honest answer for a homeschool co-op or a
      // dual-enrollment academy, and derivation cannot rank it: academicLevel degrades to
      // 'none', the seniority band to entry_intern, and an actively enrolled student
      // silently loses pre-college treatment. Only the user can say what the entry is.
      ...x.education.flatMap((e, i) => (e.level === 'other' ? [`education.${i}.level`] : [])),
      // A GPA the profile shape cannot store — a weighted figure with no unweighted
      // number (a transcript that prints only "4.321 weighted"), or either number missing
      // its scale — used to vanish here with nothing said. The stored gpa keeps a
      // value+scale pair, so anything less than that pair fell through the branch below and
      // was dropped: the number the resume stated was simply gone, and a later true
      // "4.32 weighted GPA" sentence came back red at G3 with no GPA on the profile to
      // match it. Flag any stated-but-unstorable GPA so the user completes the missing half
      // at G1 instead of the figure disappearing in silence.
      ...x.education.flatMap((e, i) => {
        const stated = e.gpaValue !== null || e.gpaScale !== null || e.gpaWeighted !== null;
        const stored = e.gpaValue !== null && e.gpaScale !== null;
        return stated && !stored ? [`education.${i}.gpa`] : [];
      }),
    ]),
    createdAt: ts,
    updatedAt: ts,
  };

  return { ...draft, derived: deriveProfile(draft, now) };
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}
