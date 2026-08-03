/**
 * Maps a ResumeExtraction onto a draft CandidateProfile.
 *
 * Everything the resume cannot tell us — date of birth, work authorization,
 * availability window, location preferences — is left at a neutral default and added to
 * `needsReview` so gate G1 forces the user to supply it. Guessing any of these would
 * silently corrupt eligibility.
 */
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

export function toDraftProfile(x: ResumeExtraction, now: Date = new Date()): CandidateProfile {
  const ts = now.toISOString();

  const skills: Skill[] = x.skills.map((s) => ({
    name: s.name,
    category: s.category,
    // Evidence is attached during confirmation, when experience/project ids are stable.
    evidence: [],
  }));

  const draft: CandidateProfile = {
    id: ulid(),
    fullName: x.fullName ?? '',
    email: x.email ?? '',
    phone: x.phone ?? undefined,
    dateOfBirth: null,
    address: { country: 'US' },
    links: {
      github: x.links.github ?? undefined,
      linkedin: x.links.linkedin ?? undefined,
      portfolio: x.links.portfolio ?? undefined,
      other: [],
    },
    workAuthorization: { country: 'US', status: 'unknown', needsSponsorship: false },
    citizenships: [],
    education: x.education.map((e) => ({
      institution: e.institution,
      level: e.level,
      fieldOfStudy: e.fieldOfStudy ?? undefined,
      startDate: e.startDate ?? undefined,
      endDate: e.endDate ?? undefined,
      gpa:
        e.gpaValue !== null && e.gpaScale !== null
          ? { value: e.gpaValue, scale: e.gpaScale }
          : undefined,
      coursework: e.coursework,
      honors: e.honors,
    })),
    experience: x.experience.map((e) => ({
      organization: e.organization,
      title: e.title,
      type: e.type,
      startDate: e.startDate ?? '1970-01',
      endDate: e.endDate ?? undefined,
      location: e.location ?? undefined,
      bullets: e.bullets,
    })),
    projects: x.projects.map((p) => ({
      name: p.name,
      description: p.description,
      url: p.url ?? undefined,
      bullets: p.bullets,
    })),
    skills,
    certifications: x.certifications.map((c) => ({
      name: c.name,
      issuer: c.issuer ?? undefined,
    })),
    languages: x.languages,
    availability: { flexible: true },
    locationPrefs: {
      base: { city: '', region: '', country: 'US' },
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
      ...(x.email ? [] : ['email']),
      // A missing start date became a sentinel above; the user must fix it, because
      // experience duration feeds the seniority band and the experience-ceiling rule.
      ...x.experience.flatMap((e, i) => (e.startDate ? [] : [`experience.${i}.startDate`])),
    ]),
    createdAt: ts,
    updatedAt: ts,
  };

  return { ...draft, derived: deriveProfile(draft, now) };
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}
