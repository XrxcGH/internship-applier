/**
 * Young-applicant resumes across domains, end to end below the model.
 *
 * freshmanResume.test.ts holds the shape that first taught the pipeline to read a rising
 * freshman — and that resume was robotics-shaped. The requirement is ANY young applicant:
 * debate and Model UN, theatre and choir, school journalism, DECA/FBLA, science fair and
 * olympiads, hospital volunteering, sports and coaching and tutoring — at any volume,
 * from nearly empty to sixteen activities and twenty-six honors. Each fixture below is a
 * domain that found real gaps when it first ran: names shaped like "St. Sample High
 * School", awards written short ("an NSPA Honorable Mention"), initialisms ("Model UN"),
 * durations phrased with service verbs ("volunteered there for five years"), role
 * families that either never existed (journalism, healthcare) or were minted from one
 * ordinary verb ("Designed weekly practice plans").
 *
 * All synthetic data. The clock is pinned: ongoing entries accrue months against "now",
 * and on the real clock every duration ceiling here would drift until the assertions
 * quietly inverted.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConfirmedProfile } from '@ia/shared';
import { ResumeExtraction } from '../src/core/ingestion/extractProfile';
import { toDraftProfile } from '../src/core/ingestion/toProfile';
import { deriveProfile } from '../src/core/ingestion/deriveFields';
import { inferRoleFamilies } from '../src/core/discovery/queryPlanner';
import { retrieveEvidence } from '../src/core/writing/retrieve';
import {
  checkClaimDeterministically,
  guardDraft,
  splitClaims,
} from '../src/core/writing/factGuard';

const NOW = new Date('2026-08-08T00:00:00Z');

beforeAll(() => {
  vi.useFakeTimers({ now: NOW });
});
afterAll(() => {
  vi.useRealTimers();
});

function confirm(extraction: unknown): ConfirmedProfile {
  const draft = toDraftProfile(ResumeExtraction.parse(extraction), NOW);
  return { ...draft, confirmedAt: NOW.toISOString() } as unknown as ConfirmedProfile;
}

// ─────────────────────────────────────────────────────────────── fixtures

const DEBATE = {
  fullName: 'Priya N. Sample',
  pronouns: 'she/her',
  email: 'priya.sample@example.com',
  phone: '+1 555 010 0199',
  location: 'Columbus, OH',
  links: { github: null, linkedin: null, portfolio: null },
  education: [
    {
      institution: 'Sample State University',
      level: 'bachelor',
      fieldOfStudy: 'Political Science',
      startDate: '2026-08',
      endDate: '2030-05',
      gpaValue: null,
      gpaScale: null,
      gpaWeighted: null,
      coursework: [],
      honors: [],
    },
    {
      institution: 'St. Sample High School',
      level: 'high_school',
      fieldOfStudy: null,
      startDate: '2022-08',
      endDate: '2026-05',
      gpaValue: 3.912,
      gpaScale: 4,
      gpaWeighted: 4.245,
      coursework: [
        'AP United States Government and Politics',
        'AP English Language and Composition',
        'AP Macroeconomics',
      ],
      honors: [
        'National Speech & Debate Association Academic All-American',
        'Best Delegate, Berkeley Model United Nations (BMUN)',
        'Ohio Speech and Debate Association State Qualifier, Lincoln-Douglas Debate (2024, 2025)',
        'National Honor Society',
        '4.245 weighted / 3.912 unweighted GPA (4.000 scale)',
      ],
    },
  ],
  experience: [
    {
      organization: 'St. Sample High School Speech & Debate Team',
      title: 'Debate Captain',
      type: 'club',
      startDate: '2024-01',
      endDate: '2026-01',
      location: null,
      bullets: [],
    },
    {
      organization: 'St. Sample High School Student Government',
      title: 'Student Body Treasurer',
      type: 'club',
      startDate: '2025-01',
      endDate: '2026-01',
      location: null,
      bullets: [],
    },
    {
      organization: 'Model United Nations Club, St. Sample High School',
      title: 'Secretary-General',
      type: 'club',
      startDate: '2024-01',
      endDate: '2026-01',
      location: null,
      bullets: [],
    },
    {
      organization: 'Sample County Mock Trial Program',
      title: 'Lead Attorney',
      type: 'club',
      startDate: '2025-01',
      endDate: '2026-01',
      location: null,
      bullets: [],
    },
    {
      organization: 'Office of State Representative Dana Samplewell',
      title: 'Legislative Volunteer',
      type: 'volunteer',
      startDate: '2025-06',
      endDate: '2025-08',
      location: 'Columbus, OH',
      bullets: [
        'Drafted constituent correspondence and tracked committee hearings for the education subcommittee',
      ],
    },
  ],
  projects: [],
  skills: [],
  certifications: [],
  languages: [{ name: 'Spanish', proficiency: 'Conversational' }],
  needsReview: [],
};

const ARTS = {
  fullName: 'Mira Ashwood',
  pronouns: null,
  email: 'mira.ashwood@example.com',
  phone: null,
  location: 'Maple City, OH',
  links: { github: null, linkedin: null, portfolio: 'mira-ashwood-art.example.com' },
  education: [
    {
      institution: 'St. Sample High School',
      level: 'high_school',
      fieldOfStudy: null,
      startDate: '2023-08',
      endDate: '2027-05',
      gpaValue: 3.912,
      gpaScale: 4,
      gpaWeighted: 4.267,
      coursework: [
        'AP Studio Art: Drawing',
        'Concert Choir',
        'AP English Language and Composition',
      ],
      honors: [
        'Scholastic Art & Writing Awards — Gold Key, Drawing & Illustration (2025)',
        'All-State Honor Choir (2024, 2025)',
        'International Thespian Society inductee (2024)',
        'Outstanding Lead Performance, Riverbend One-Act Festival (2025)',
      ],
    },
  ],
  experience: [
    {
      organization: 'St. Sample High School Theatre Program',
      title: 'Lead — The Glass Aviary (fall play)',
      type: 'club',
      startDate: '2024-01',
      endDate: '2024-01',
      location: null,
      bullets: [],
    },
    {
      organization: 'St. Sample High School Chamber Choir',
      title: 'Soprano Section Leader',
      type: 'club',
      startDate: '2023-01',
      endDate: null,
      location: null,
      bullets: [],
    },
    {
      organization: 'Maple City Community Theatre',
      title: 'Volunteer Stage Crew',
      type: 'volunteer',
      startDate: '2024-01',
      endDate: '2025-01',
      location: 'Maple City, OH',
      bullets: [],
    },
    {
      organization: 'National Art Honor Society, St. Sample Chapter',
      title: 'Member',
      type: 'club',
      startDate: '2024-01',
      endDate: null,
      location: null,
      bullets: [],
    },
    {
      organization: 'St. Sample High School Wind Ensemble',
      title: 'First Clarinet',
      type: 'club',
      startDate: '2023-01',
      endDate: null,
      location: null,
      bullets: [],
    },
  ],
  projects: [
    {
      name: 'Faces of Maple City',
      description:
        'Charcoal portrait series of twelve local residents, exhibited at the Maple City Public Library in spring 2025.',
      url: null,
      bullets: [],
    },
  ],
  skills: [],
  certifications: [],
  languages: [],
  needsReview: [],
};

const SPORTS = {
  fullName: 'Maya Trellis',
  pronouns: null,
  email: 'maya.trellis@example.com',
  phone: null,
  location: 'Riverton, OH',
  links: { github: null, linkedin: null, portfolio: null },
  education: [
    {
      institution: 'St. Sample High School',
      level: 'high_school',
      fieldOfStudy: null,
      startDate: '2024-08',
      endDate: '2028-05',
      gpaValue: 3.842,
      gpaScale: 4,
      gpaWeighted: 4.213,
      coursework: [],
      honors: ['Scholar-Athlete Award (2025)', 'Varsity Letter, Swimming (2025, 2026)'],
    },
  ],
  experience: [
    {
      organization: 'Harborview Aquatic Club',
      title: 'Assistant Swim Coach',
      type: 'job',
      startDate: '2024-06',
      endDate: null,
      location: 'Riverton, OH',
      bullets: [
        'Led warm-up drills and stroke instruction for 25 swimmers aged 8-12',
        'Designed weekly practice plans with the head coach',
        'Timed heats and recorded results at six club meets',
      ],
    },
    {
      organization: 'Riverton Riptides Swim Club',
      title: 'Team Captain, U15 Squad',
      type: 'club',
      startDate: '2023-01',
      endDate: '2024-01',
      location: null,
      bullets: [],
    },
    {
      organization: 'Bridgeview Community Center',
      title: 'Volunteer Math Tutor',
      type: 'volunteer',
      startDate: '2025-09',
      endDate: null,
      location: null,
      bullets: ['Tutor middle school students in pre-algebra and algebra twice a week'],
    },
    {
      organization: 'Pageturners Literacy Project',
      title: 'Volunteer Reading Tutor',
      type: 'volunteer',
      startDate: '2024',
      endDate: null,
      location: null,
      bullets: [],
    },
  ],
  projects: [],
  skills: [],
  certifications: [
    {
      name: 'American Red Cross Lifeguarding/First Aid/CPR/AED',
      issuer: 'American Red Cross',
      date: '2025-06',
    },
  ],
  languages: [],
  needsReview: [],
};

const NEWS = {
  fullName: 'Mara Quillen',
  pronouns: 'she/her',
  email: 'mara.quillen@example.com',
  phone: '(973) 555-0142',
  location: 'Maplewood, NJ',
  links: { github: null, linkedin: null, portfolio: null },
  education: [
    {
      institution: 'St. Sample High School',
      level: 'high_school',
      fieldOfStudy: null,
      startDate: '2023-01',
      endDate: '2027-01',
      gpaValue: 3.912,
      gpaScale: 4.0,
      gpaWeighted: 4.287,
      coursework: ['AP English Language and Composition', 'Honors Journalism'],
      honors: [
        'Columbia Scholastic Press Association Gold Circle Award — First Place, News Writing (2025)',
        'NSPA Individual Awards Honorable Mention, Feature Story of the Year (2024)',
        'Quill and Scroll International Honor Society (inducted 2024)',
      ],
    },
  ],
  experience: [
    {
      organization: 'The Sample Sentinel (St. Sample High School Student Newspaper)',
      title: 'Editor-in-Chief',
      type: 'club',
      startDate: '2025-01',
      endDate: null,
      location: null,
      bullets: [],
    },
    {
      organization: 'The Sample Sentinel',
      title: 'News Section Editor',
      type: 'club',
      startDate: '2024-01',
      endDate: '2025-01',
      location: null,
      bullets: [],
    },
    {
      organization: 'The Sampler Yearbook',
      title: 'Copy Editor',
      type: 'club',
      startDate: '2023-01',
      endDate: '2024-01',
      location: null,
      bullets: [],
    },
    {
      organization: 'Maplewood Public Library',
      title: 'Teen Writing Workshop Volunteer',
      type: 'volunteer',
      startDate: '2024-01',
      endDate: null,
      location: 'Maplewood, NJ',
      bullets: [],
    },
  ],
  projects: [],
  skills: [],
  certifications: [],
  languages: [],
  needsReview: [],
};

const SCIOLY = {
  fullName: 'Priya Samplestone',
  pronouns: null,
  email: 'priya.samplestone@example.com',
  phone: '(555) 010-2233',
  location: 'Sample City, OH',
  links: { github: null, linkedin: null, portfolio: null },
  education: [
    {
      institution: 'Westfield Sample High School',
      level: 'high_school',
      fieldOfStudy: null,
      startDate: '2023-08',
      endDate: '2027-06',
      gpaValue: 3.972,
      gpaScale: 4.0,
      gpaWeighted: 4.418,
      coursework: ['AP Biology', 'AP Chemistry', 'AP Calculus BC', 'AP Computer Science A'],
      honors: [
        'Regeneron ISEF Finalist, Microbiology (2025)',
        'Science Olympiad National Tournament, 2nd Place Medal, Disease Detectives (2024)',
        'AIME Qualifier (2024, 2025)',
        'AMC 12 Distinguished Honor Roll (2025)',
        'USACO Silver Division (2024)',
        'National Merit Commended Student (2025)',
      ],
    },
  ],
  experience: [
    {
      organization: 'Westfield Sample High School Science Olympiad',
      title: 'Team Co-Captain',
      type: 'club',
      startDate: '2023-01',
      endDate: null,
      location: null,
      bullets: [],
    },
    {
      organization: 'Westfield Sample High School Math Team',
      title: 'Captain',
      type: 'club',
      startDate: '2024-01',
      endDate: null,
      location: null,
      bullets: [],
    },
    {
      organization: 'Sample City Middle School Math Circle',
      title: 'Volunteer Tutor',
      type: 'volunteer',
      startDate: '2025-01',
      endDate: null,
      location: null,
      bullets: [],
    },
  ],
  projects: [
    {
      name: 'Effects of Microplastic Concentration on Daphnia Heart Rate',
      description:
        'Independent research project in microbiology; measured cardiac response across exposure levels and performed statistical analysis of dose-response curves. Regeneron ISEF Finalist, 2025.',
      url: null,
      bullets: [],
    },
  ],
  skills: [],
  certifications: [],
  languages: [],
  needsReview: [],
};

const DECA = {
  fullName: 'Jordan T. Vasquez',
  pronouns: null,
  email: 'jordan.vasquez.example@gmail.com',
  phone: '(480) 555-0142',
  location: 'Mesa, AZ',
  links: { github: null, linkedin: 'linkedin.com/in/jordantvasquez-sample', portfolio: null },
  education: [
    {
      institution: 'St. Sample High School',
      level: 'high_school',
      fieldOfStudy: null,
      startDate: '2023-08',
      endDate: '2027-06',
      gpaValue: 3.912,
      gpaScale: 4.0,
      gpaWeighted: 4.408,
      coursework: ['AP Microeconomics', 'AP Statistics', 'Honors Accounting I'],
      honors: [
        'DECA International Career Development Conference (ICDC) Finalist, Entrepreneurship Series (2026)',
        'DECA Arizona State Career Development Conference, 1st Place, Principles of Marketing (2025)',
        'FBLA State Leadership Conference, 2nd Place, Introduction to Business Concepts (2025)',
        'FBLA Regional Leadership Conference, 1st Place, Accounting I (2024)',
        'National Honor Society (2025)',
      ],
    },
  ],
  experience: [
    {
      organization: 'St. Sample High School DECA Chapter',
      title: 'Vice President of Finance',
      type: 'club',
      startDate: '2025-01',
      endDate: null,
      location: 'Mesa, AZ',
      bullets: [],
    },
    {
      organization: 'St. Sample High School Store',
      title: 'Student Store Manager',
      type: 'job',
      startDate: '2024-09',
      endDate: null,
      location: 'Mesa, AZ',
      bullets: [
        'Manage daily operations, cash handling, and weekly restocking for the student-run school store',
        'Reconcile the register and track weekly sales in Google Sheets',
      ],
    },
    {
      organization: 'FBLA',
      title: 'Chapter Treasurer',
      type: 'club',
      startDate: '2024-01',
      endDate: null,
      location: null,
      bullets: [],
    },
    {
      organization: 'Reyes Custom Prints',
      title: 'Founder',
      type: 'freelance',
      startDate: '2024-06',
      endDate: null,
      location: null,
      bullets: [
        'Design and sell custom vinyl stickers on Etsy; fulfilled over 300 orders',
        'Set prices, photograph products, and answer customer messages',
      ],
    },
  ],
  projects: [],
  skills: [],
  certifications: [],
  languages: [{ name: 'Spanish', proficiency: 'Conversational' }],
  needsReview: [],
};

const PREMED = {
  fullName: 'Maya Okafor',
  pronouns: null,
  email: 'maya.okafor@example.com',
  phone: '(937) 555-0142',
  location: 'Dayton, OH',
  links: { github: null, linkedin: null, portfolio: null },
  education: [
    {
      institution: 'St. Sample High School',
      level: 'high_school',
      fieldOfStudy: null,
      startDate: '2023-01',
      endDate: '2027-01',
      gpaValue: 3.972,
      gpaScale: 4,
      gpaWeighted: 4.412,
      coursework: ['Honors Anatomy and Physiology', 'AP Biology', 'AP Chemistry'],
      honors: [
        'HOSA State Leadership Conference Qualifier — Medical Terminology (2025)',
        'National Honor Society, inducted 2024',
        "President's Volunteer Service Award — Gold (2025)",
      ],
    },
  ],
  experience: [
    {
      organization: 'Mercy Sample Regional Medical Center',
      title: 'Patient Transport Volunteer',
      type: 'volunteer',
      startDate: '2024-06',
      endDate: null,
      location: 'Dayton, OH',
      bullets: [
        'Transported patients between the Emergency Department and imaging, and restocked supply carts.',
      ],
    },
    {
      organization: 'St. Sample High School Red Cross Club',
      title: 'President',
      type: 'club',
      startDate: '2024-01',
      endDate: null,
      location: null,
      bullets: [],
    },
    {
      organization: 'HOSA — Future Health Professionals',
      title: 'Competitor, Medical Terminology',
      type: 'club',
      startDate: '2025-01',
      endDate: null,
      location: null,
      bullets: [],
    },
    {
      organization: 'Key Club International',
      title: 'Member',
      type: 'volunteer',
      startDate: '2023-01',
      endDate: null,
      location: null,
      bullets: [],
    },
  ],
  projects: [],
  skills: [],
  certifications: [
    {
      name: 'Adult and Pediatric First Aid/CPR/AED',
      issuer: 'American Red Cross',
      date: '2024-03',
    },
  ],
  languages: [],
  needsReview: [],
};

const MAXIMAL = {
  fullName: 'Priya Ramanathan-Cole',
  pronouns: 'she/her',
  email: 'priya.rc.example@gmail.com',
  phone: '(555) 014-2288',
  location: 'Maplewood, OH',
  links: { github: null, linkedin: null, portfolio: null },
  education: [
    {
      institution: 'St. Sample High School',
      level: 'high_school',
      fieldOfStudy: null,
      startDate: '2022-01',
      endDate: '2026-01',
      gpaValue: 3.972,
      gpaScale: 4.0,
      gpaWeighted: 4.518,
      coursework: [
        'AP Calculus BC',
        'AP Biology',
        'AP English Language and Composition',
        'AP United States History',
        'AP Statistics',
      ],
      honors: [
        'National Merit Semifinalist (2025)',
        'AP Scholar with Distinction (2025)',
        'NSDA Academic All-American',
        'NSDA District Champion, Lincoln-Douglas Debate (2025)',
        'Best Delegate, Great Lakes Model United Nations Conference (2024)',
        'Outstanding Delegation, Sample State MUN (2025)',
        'DECA International Career Development Conference (ICDC) Finalist, Principles of Marketing (2025)',
        'DECA State Career Development Conference, 1st Place, Entrepreneurship Series (2025)',
        'FBLA State Leadership Conference, 2nd Place, Personal Finance (2024)',
        'Science Olympiad Regional Tournament, 1st Place, Anatomy and Physiology (2024)',
        'Science Olympiad State Tournament, 3rd Place, Disease Detectives (2025)',
        'Sample Regional Science and Engineering Fair, Grand Award, Behavioral Sciences (2025)',
        'AMC 12 Distinguished Honor Roll (2025)',
        'AIME Qualifier (2025)',
        'National Latin Exam, Gold Medal, Summa Cum Laude (2024)',
        'Scholastic Art and Writing Awards, Silver Key, Journalism (2024)',
        'Quill and Scroll International Honor Society, Inductee (2024)',
        'Columbia Scholastic Press Association, Gold Circle Award, News Writing (2025)',
        'All-State Honor Band, Second Chair Trumpet (2025)',
        'International Thespian Society, Honor Thespian (2025)',
        "President's Volunteer Service Award, Gold Level (2025)",
        'Rotary Youth Leadership Awards (RYLA) Delegate (2024)',
        'All-Conference Academic Team, Girls Varsity Soccer (2025)',
        'Coaches Award, Varsity Soccer (2024)',
        "Principal's Honor Roll, All Semesters",
      ],
    },
    {
      institution: 'Lakeview Community College',
      level: 'other',
      fieldOfStudy: 'Dual Enrollment',
      startDate: '2024-01',
      endDate: '2026-01',
      gpaValue: 3.85,
      gpaScale: 4.0,
      gpaWeighted: null,
      coursework: ['Introduction to Psychology', 'Public Speaking', 'Macroeconomics'],
      honors: ["President's List (Fall 2025)"],
    },
  ],
  experience: [
    {
      organization: 'St. Sample High School Speech & Debate Team',
      title: 'Captain',
      type: 'club',
      startDate: '2023-01',
      endDate: '2026-01',
      location: null,
      bullets: [],
    },
    {
      organization: 'Model United Nations, St. Sample High School',
      title: 'Secretary-General',
      type: 'club',
      startDate: '2022-01',
      endDate: '2026-01',
      location: null,
      bullets: [],
    },
    {
      organization: 'The Sample Sentinel (Student Newspaper)',
      title: 'Editor-in-Chief',
      type: 'club',
      startDate: '2022-01',
      endDate: '2026-01',
      location: null,
      bullets: [],
    },
    {
      organization: 'DECA, St. Sample Chapter',
      title: 'Chapter President',
      type: 'club',
      startDate: '2023-01',
      endDate: '2026-01',
      location: null,
      bullets: [],
    },
    {
      organization: 'FBLA',
      title: 'Vice President of Finance',
      type: 'club',
      startDate: '2024-01',
      endDate: '2026-01',
      location: null,
      bullets: [],
    },
    {
      organization: 'Science Olympiad',
      title: 'Team Captain',
      type: 'club',
      startDate: '2022-01',
      endDate: '2026-01',
      location: null,
      bullets: [],
    },
    {
      organization: 'St. Sample Players (Theatre)',
      title: 'Stage Manager',
      type: 'club',
      startDate: '2022-01',
      endDate: '2026-01',
      location: null,
      bullets: [],
    },
    {
      organization: 'St. Sample Players (Theatre)',
      title: 'Lighting Designer',
      type: 'club',
      startDate: '2024-01',
      endDate: '2026-01',
      location: null,
      bullets: [],
    },
    {
      organization: 'St. Sample High School Concert and Jazz Band',
      title: 'Section Leader, Trumpet',
      type: 'club',
      startDate: '2022-01',
      endDate: '2026-01',
      location: null,
      bullets: [],
    },
    {
      organization: 'Sample Valley Medical Center',
      title: 'Volunteer, Emergency Department',
      type: 'volunteer',
      startDate: '2024-01',
      endDate: '2026-01',
      location: null,
      bullets: [],
    },
    {
      organization: 'Riverbend Youth Soccer League',
      title: 'Assistant Coach',
      type: 'volunteer',
      startDate: '2023-01',
      endDate: '2026-01',
      location: null,
      bullets: [],
    },
    {
      organization: 'St. Sample High School Varsity Soccer',
      title: 'Team Captain',
      type: 'club',
      startDate: '2022-01',
      endDate: '2026-01',
      location: null,
      bullets: [],
    },
    {
      organization: 'Bright Minds Tutoring Center',
      title: 'Math Tutor',
      type: 'job',
      startDate: '2024-01',
      endDate: null,
      location: null,
      bullets: [],
    },
    {
      organization: 'Oakwood Community Pool',
      title: 'Lifeguard',
      type: 'job',
      startDate: '2025-01',
      endDate: '2025-01',
      location: null,
      bullets: [],
    },
    {
      organization: 'Key Club International',
      title: 'Chapter Treasurer',
      type: 'volunteer',
      startDate: '2023-01',
      endDate: '2026-01',
      location: null,
      bullets: [],
    },
    {
      organization: 'National Honor Society, St. Sample Chapter',
      title: 'Member',
      type: 'club',
      startDate: '2024-01',
      endDate: '2026-01',
      location: null,
      bullets: [],
    },
  ],
  projects: [],
  skills: [],
  certifications: [],
  languages: [{ name: 'Spanish', proficiency: 'conversational' }],
  needsReview: [],
};

const EMPTY = {
  fullName: 'Jordan Weaver',
  pronouns: null,
  email: null,
  phone: null,
  location: 'Springfield, OH',
  links: { github: null, linkedin: null, portfolio: null },
  education: [
    {
      institution: 'St. Sample High School',
      level: 'high_school',
      fieldOfStudy: null,
      startDate: null,
      endDate: '2027-01',
      gpaValue: null,
      gpaScale: null,
      gpaWeighted: null,
      coursework: [],
      honors: [],
    },
  ],
  experience: [
    {
      organization: 'St. Sample High School Chess Club',
      title: 'Member',
      type: 'club',
      startDate: null,
      endDate: null,
      location: null,
      bullets: [],
    },
    {
      organization: 'Sample Community Food Pantry',
      title: 'Volunteer',
      type: 'volunteer',
      startDate: '2025-01',
      endDate: null,
      location: null,
      bullets: [],
    },
  ],
  projects: [],
  skills: [],
  certifications: [],
  languages: [],
  needsReview: [],
};

const AWKWARD = {
  fullName: 'Marisol Vega',
  pronouns: null,
  email: 'marisol.vega.example@gmail.com',
  phone: null,
  location: 'Fort Sample, FL',
  links: { github: null, linkedin: null, portfolio: null },
  education: [
    {
      institution: 'Design and Architecture Senior High',
      level: 'high_school',
      fieldOfStudy: null,
      startDate: '2023-08',
      endDate: '2027-05',
      gpaValue: 3.917,
      gpaScale: 4,
      gpaWeighted: 4.462,
      coursework: [],
      honors: [
        "President's Volunteer Service Award (Gold)",
        'Eagle Scout',
        'Gracious Professionalism (5 recognitions)',
        'National Merit Commended Scholar, Class of 2027',
      ],
    },
  ],
  experience: [
    {
      organization: "St. Sample Children's Hospital",
      title: 'Volunteer, Family Services Desk',
      type: 'volunteer',
      startDate: '2024-06',
      endDate: null,
      location: 'Fort Sample, FL',
      bullets: [],
    },
    {
      organization: 'Scouts BSA Troop 214',
      title: 'Senior Patrol Leader',
      type: 'club',
      startDate: '2021-01',
      endDate: null,
      location: null,
      bullets: [],
    },
  ],
  projects: [],
  skills: [],
  certifications: [],
  languages: [],
  needsReview: [],
};

// ─────────────────────────────────────────── debate / MUN / student government

describe('debate, Model UN, mock trial, student government', () => {
  const p = confirm(DEBATE);
  const ev = retrieveEvidence(p, 'Tell us about a leadership experience you are proud of.', {
    limit: 20,
  });
  const det = (c: string) => checkClaimDeterministically(c, ev);

  /**
   * "St. Sample High School" is one name whether or not the writer keeps the dot.
   * normalize() kept it while the claim side stripped it, so the two spellings of the
   * student's own school could never vouch for each other — red at G3, no override.
   */
  it('accepts the student\'s own "St."-prefixed school, whole, in one claim', () => {
    expect(det('I served as student body treasurer of St. Sample High School.').verdict).toBeNull();
    expect(det('I have a 3.912 GPA at St. Sample High School.').verdict).toBeNull();
  });

  /** Every MUN student writes "Model UN"; the NSDA abbreviates itself. */
  it('accepts the standard short form of a name the profile holds in full', () => {
    expect(det('I served as secretary-general of our Model UN club.').verdict).toBeNull();
    expect(det('I competed in Model UN for two years.').verdict).toBeNull();
    expect(det('I earned the NSDA Academic All-American award.').verdict).toBeNull();
    // Controls: the full form and a literally-printed acronym were always fine.
    expect(det('I was secretary-general of the Model United Nations Club.').verdict).toBeNull();
    expect(det('I won Best Delegate at BMUN.').verdict).toBeNull();
  });

  it('measures an unscoped work claim against work, not the high-school span', () => {
    const r = det('I worked in the state legislature for three years.');
    expect(r.verdict).toBe('overstated');
    // 24 months is the longest club entry; 45 would be the school. The message must
    // describe an entry the student can actually find.
    expect(r.reason).toMatch(/24 months/);
  });

  /**
   * Position inflation — president for treasurer — is semantic, so it stays with the
   * human at G3. But the lexical layer must not hand that human 'supported' with the
   * contradicting Treasurer line quoted as proof.
   */
  it('caps a fabricated office at amber instead of green', () => {
    const g = guardDraft('I served as student body president.', ev);
    expect(g.claims.every((c) => c.verdict !== 'supported')).toBe(true);
    expect(g.blocking).toEqual([]);
  });

  it('infers the public policy family and no design family', () => {
    const fams = inferRoleFamilies(p);
    expect(fams).toContain('public policy');
    expect(fams).not.toContain('design');
  });
});

// ─────────────────────────────────────────── performing and visual arts

describe('theatre, choir, band, visual art', () => {
  const p = confirm(ARTS);
  const ev = retrieveEvidence(p, 'Tell us about an activity that matters to you.', { limit: 20 });
  const det = (c: string) => checkClaimDeterministically(c, ev);

  /**
   * "Performed / sang / played for N years" IS how an arts student states tenure. With
   * only office verbs in the duration gate, the one duration sentence they would actually
   * write was the one shape the guard could not see, and six years against a 43-month
   * choir entry came back approvable.
   */
  it('measures durations phrased with performing-arts verbs', () => {
    for (const c of [
      'I have performed with the Chamber Choir for six years.',
      'I sang in the Chamber Choir for six years.',
      'I have played clarinet in the Wind Ensemble for ten years.',
      'I acted with the Theatre Program for five years.',
      'I rehearsed with the Chamber Choir for six years.',
      'I served as Soprano Section Leader for six years.',
      'I performed in the Wind Ensemble for nine years.',
    ]) {
      expect(det(c).verdict, c).toBe('overstated');
    }
    expect(
      guardDraft('I have performed with the Chamber Choir for six years.', ev).blocking.length,
    ).toBeGreaterThan(0);
  });

  it('still accepts the honest tenure', () => {
    expect(det('I have performed with the Chamber Choir for three years.').verdict).toBeNull();
  });

  /**
   * No arts role family exists in the taxonomy (a deliberate scope decision — the four
   * families added were the ones with a clear internship market), so the correct result
   * is zero families and the honest broad-search note — never a spurious family from
   * "Lead", "design"-adjacent art coursework, or "content".
   */
  it('infers no spurious families from an arts-only resume', () => {
    expect(inferRoleFamilies(p)).toEqual([]);
  });
});

// ─────────────────────────────────────────── sports + coaching + tutoring

describe('sports, coaching, tutoring', () => {
  const p = confirm(SPORTS);
  const ev = retrieveEvidence(p, 'Describe a time you led a team.', { limit: 20 });
  const det = (c: string) => checkClaimDeterministically(c, ev);

  /**
   * "Designed weekly practice plans" is an ordinary resume verb, not UX evidence. It used
   * to be the only taxonomy hit on this profile, so a swim coach got Figma queries — and
   * with that fixed, the commonest young-applicant shape (coaching, tutoring, lifeguard)
   * inferred nothing at all until an education family existed for it.
   */
  it('infers education, not design, from a coaching-and-tutoring resume', () => {
    const fams = inferRoleFamilies(p);
    expect(fams).not.toContain('design');
    expect(fams).toContain('education');
  });

  it('catches inflated tutoring at a named org', () => {
    const g = guardDraft(
      'I have tutored middle school students at Bridgeview Community Center for five years.',
      ev,
    );
    expect(
      g.blocking.some((c) => c.verdict === 'overstated' && /11 months/.test(c.reason ?? '')),
    ).toBe(true);
  });

  it('measures unscoped work claims against work, not the future-dated school entry', () => {
    // The school entry runs to a 2028 graduation — 21 months not yet lived. It must not
    // hand a work claim a 56-month ceiling when the longest real job is 26 months.
    const g = guardDraft('I have worked as a swim coach for four years.', ev);
    expect(
      g.blocking.some((c) => c.verdict === 'overstated' && /26 months/.test(c.reason ?? '')),
    ).toBe(true);
    expect(det('I coached competitive swimmers for six years.').verdict).toBe('overstated');
  });

  it('does not let an undated entry make its inflation green', () => {
    // Pageturners has a year-only start the schema dropped, so scoping finds no dates;
    // the fallback still measures against the real work entries rather than waving it by.
    const g = guardDraft('I volunteered at Pageturners Literacy Project for three years.', ev);
    expect(g.claims.every((c) => c.verdict !== 'supported')).toBe(true);
  });

  it("caps the head-coach fabrication at amber — the boss's bullet is not a title", () => {
    // "Designed weekly practice plans with the head coach" mentions the writer's BOSS,
    // and that mention used to push the claim to 'supported' with the bullet as proof.
    const g = guardDraft('I was the head coach of the varsity team at St. Sample High School.', ev);
    expect(g.claims.every((c) => c.verdict !== 'supported')).toBe(true);
    expect(g.blocking).toEqual([]);
  });

  it('reads a whole "St." sentence as one claim and passes true facts in it', () => {
    expect(det('I have a 4.213 weighted GPA at St. Sample High School.').verdict).toBeNull();
    const g = guardDraft('I am a rising sophomore at St. Sample High School with a 3.842 GPA.', ev);
    expect(g.claims).toHaveLength(1);
    expect(g.blocking).toEqual([]);
  });

  it('keeps the scoped ceiling honest in both directions', () => {
    expect(det('I have worked at Harborview Aquatic Club for two years.').verdict).toBeNull();
    expect(det('I have worked at Harborview Aquatic Club for four years.').verdict).toBe(
      'overstated',
    );
  });
});

// ─────────────────────────────────────────── school newspaper and yearbook

describe('school newspaper and yearbook', () => {
  const p = confirm(NEWS);
  const ev = retrieveEvidence(p, 'Tell us about your writing.', { limit: 20 });
  const det = (c: string) => checkClaimDeterministically(c, ev);

  /**
   * The natural short forms of a long award name. The full honor is "NSPA Individual
   * Awards Honorable Mention, Feature Story of the Year (2024)"; nobody writes all of it,
   * and the shortened forms were blocked at G3 — one of them with a mangled fragment
   * ("Year Honorable Mention") quoted back as the invented name.
   */
  it('accepts an award shortened or reordered by its writer', () => {
    expect(det('I earned an NSPA Honorable Mention for my feature story.').verdict).toBeNull();
    expect(det('My story won the Feature Story of the Year Honorable Mention.').verdict).toBeNull();
    expect(
      det('I earned an NSPA Individual Awards Honorable Mention for my feature story.').verdict,
    ).toBeNull();
  });

  it('still blocks an award the profile does not hold', () => {
    expect(det('I won the Pacemaker Grand Prize last year.').verdict).toBe('unsupported');
  });

  it('infers the journalism family for a decorated editor-in-chief', () => {
    expect(inferRoleFamilies(p)).toContain('journalism');
  });
});

// ─────────────────────────────────────────── science fair and olympiads

describe('science fair and olympiads without robotics', () => {
  const p = confirm(SCIOLY);
  const ev = retrieveEvidence(p, 'Tell us about a project you loved.', { limit: 20 });

  /**
   * A bullet-less resume's only evidence for the tutoring role is the title line
   * "Volunteer Tutor at ...". Without inflection folding, "tutored" never matched
   * "Tutor", coverage fell under the action-claim bar, and TRUE sentences about the
   * profile's own role were blocked at G3 with a remedy that had already been done.
   */
  it("passes true past-tense sentences about the profile's own tutor role", () => {
    for (const c of [
      'I have tutored middle schoolers for a year now.',
      'I have tutored middle schoolers for one year.',
      'I tutored sixth graders in math once a week.',
    ]) {
      expect(guardDraft(c, ev).blocking, c).toEqual([]);
    }
  });

  it('measures activity-verb durations that used to pass unchecked', () => {
    for (const c of [
      'I have coached the middle school math circle for five years.',
      'I have been mentoring younger students for five years.',
      'I have volunteered at the math circle for five years.',
      'I competed in Science Olympiad for six years.',
      'I have been tutoring middle school students for five years.',
    ]) {
      expect(
        guardDraft(c, ev).blocking.some((x) => x.verdict === 'overstated'),
        c,
      ).toBe(true);
    }
  });

  it('reads USACO and AP Computer Science as software engineering evidence', () => {
    expect(inferRoleFamilies(p)).toContain('software engineering');
  });

  /** "Microbiology" contains no word boundary before "biolog"; the stem needed a sibling. */
  it('reads microbiology as biology evidence even with no coursework listed', () => {
    const micro = confirm({ ...SCIOLY, education: [{ ...SCIOLY.education[0], coursework: [] }] });
    expect(inferRoleFamilies(micro)).toContain('biology');
  });
});

// ─────────────────────────────────────────── DECA / FBLA

describe('DECA and FBLA business clubs', () => {
  const p = confirm(DECA);
  const ev = retrieveEvidence(p, 'Why do you want this internship?', { limit: 20 });

  /**
   * The one search this student would type is "marketing internship" — they hold a state
   * 1st place in Principles of Marketing. It was evicted from the four-slot plan by
   * families minted from Etsy-shop phrasing: "Design and sell custom vinyl stickers" is
   * not a UX background and "photograph products" is not product management.
   */
  it('keeps marketing and operations; mints nothing from sticker-shop phrasing', () => {
    const fams = inferRoleFamilies(p);
    expect(fams).toContain('marketing');
    expect(fams).toContain('operations');
    expect(fams).not.toContain('design');
    expect(fams).not.toContain('product management');
  });

  it('does not block "At ICDC, ..." — the ordinary competition-sentence opener', () => {
    expect(
      guardDraft('At ICDC, I advanced to the national finals in my event.', ev).blocking,
    ).toEqual([]);
  });

  it('accepts the school name with or without the abbreviation dot', () => {
    expect(
      guardDraft(
        'I have worked at the school store at St Sample High School since my sophomore year.',
        ev,
      ).blocking,
    ).toEqual([]);
  });

  it('still catches the four-year store inflation (real tenure: 23 months)', () => {
    const g = guardDraft('I have worked at the school store for four years.', ev);
    expect(g.blocking.some((c) => c.verdict === 'overstated')).toBe(true);
  });

  /**
   * A school-store job beside an Etsy venture summed to 4.1 years of professional
   * experience inside 26 calendar months, which would clear a "3+ years required"
   * posting for a sixteen-year-old. Concurrent months count once.
   */
  it('caps professional experience at elapsed calendar time', () => {
    const d = deriveProfile(toDraftProfile(ResumeExtraction.parse(DECA), NOW), NOW);
    expect(d.yearsProfessionalExperience).toBeLessThanOrEqual(2.2);
    expect(d.yearsProfessionalExperience).toBeGreaterThanOrEqual(1.5);
  });
});

// ─────────────────────────────────────────── hospital volunteering, pre-med

describe('hospital and community volunteering, pre-med shape', () => {
  const p = confirm(PREMED);
  const ev = retrieveEvidence(p, 'Tell us about your community involvement.', { limit: 20 });
  const det = (c: string) => checkClaimDeterministically(c, ev);

  it('measures the durations a pre-med student actually writes', () => {
    for (const c of [
      'I have volunteered at Mercy Sample Regional Medical Center for five years.',
      'I have served as President of the Red Cross Club for six years.',
      'I shadowed physicians at Mercy Sample Regional Medical Center for four years.',
      'I have been a member of Key Club for six years.',
    ]) {
      expect(
        guardDraft(c, ev).blocking.some((x) => x.verdict === 'overstated'),
        c,
      ).toBe(true);
    }
    expect(
      guardDraft('I have volunteered at Mercy Sample Regional Medical Center for two years.', ev)
        .blocking,
    ).toEqual([]);
  });

  it('does not mark an invented EMT certification green', () => {
    // Amber, not red: the cert name is an acronym with no affiliation frame, so the
    // deterministic layer cannot prove the fabrication — but nothing here says it
    // checks out either.
    const g = guardDraft('I have been a certified EMT for three years.', ev);
    expect(g.claims.every((c) => c.verdict !== 'supported')).toBe(true);
  });

  it('infers healthcare from the healthcare evidence itself, not only coursework', () => {
    expect(inferRoleFamilies(p)).toContain('healthcare');
    const noCourse = confirm({
      ...PREMED,
      education: [{ ...PREMED.education[0], coursework: [] }],
    });
    expect(inferRoleFamilies(noCourse)).toContain('healthcare');
  });

  it('passes the whole President-at-St.-school sentence deterministically', () => {
    expect(
      det('I served as President of the Red Cross Club at St. Sample High School.').verdict,
    ).toBeNull();
  });
});

// ─────────────────────────────────────────── maximal volume

describe('maximal-volume resume: 16 activities, 26 honors, two schools', () => {
  const p = confirm(MAXIMAL);
  const ev = retrieveEvidence(p, 'Tell us about a leadership experience that shaped you.');

  /**
   * At the default limit, all sixteen bullet-less role lines score identically and the
   * stable sort cut entries 12-15 for any generic question — including the student's
   * only real job and the second school. True sentences about either came back as
   * invented names at G3.
   */
  it('rescues every school and every real job into the evidence set', () => {
    const refs = ev.map((e) => e.ref);
    expect(refs).toContain('experience.12'); // Bright Minds Tutoring Center — the job
    expect(refs).toContain('education.1'); // Lakeview Community College — second GPA
    expect(
      guardDraft('I worked as a math tutor at Bright Minds Tutoring Center.', ev).blocking,
    ).toEqual([]);
    expect(
      guardDraft(
        'I earned a 3.85 GPA in my dual enrollment coursework at Lakeview Community College.',
        ev,
      ).blocking,
    ).toEqual([]);
  });

  /**
   * The deterministic layer verified 3.972 against the profile and returned silence, and
   * the lexical layer then blocked the sentence because "unweighted" and "scale" appear
   * nowhere in the evidence. A number the guard itself confirmed cannot be red.
   */
  it('does not lexically block a claim whose GPA the guard just verified', () => {
    expect(
      guardDraft(
        'I maintained a 3.972 unweighted GPA on a 4.000 scale while taking five AP courses.',
        ev,
      ).blocking,
    ).toEqual([]);
    expect(guardDraft('I maintained a 3.5 GPA throughout.', ev).blocking).toHaveLength(1);
  });

  it('mints no families from a fair name or a theatre credit', () => {
    const fams = inferRoleFamilies(p);
    // "Science and Engineering Fair" is not a software background; a Lighting Designer
    // is not a UX designer. Both slots go to families with real evidence behind them.
    expect(fams).not.toContain('software engineering');
    expect(fams).not.toContain('design');
    expect(fams).toContain('public policy');
  });

  it('flags dual enrollment\'s level "other" for the user instead of degrading silently', () => {
    const draft = toDraftProfile(ResumeExtraction.parse(MAXIMAL), NOW);
    expect(draft.needsReview).toContain('education.1.level');
  });

  /**
   * If the extractor labels the community college "associate", its past end date used to
   * promote a 17-year-old to new_grad — the band that says they finished college. A
   * "degree" that ended no later than high school did is dual enrollment.
   */
  it('never bands a dual-enrollment high schooler as a new grad', () => {
    const assoc = ResumeExtraction.parse({
      ...MAXIMAL,
      education: [MAXIMAL.education[0], { ...MAXIMAL.education[1], level: 'associate' }],
    });
    expect(deriveProfile(toDraftProfile(assoc, NOW), NOW).seniorityBand).not.toBe('new_grad');

    const enrolled = ResumeExtraction.parse({
      ...MAXIMAL,
      education: [
        { ...MAXIMAL.education[0], endDate: '2027-01' },
        { ...MAXIMAL.education[1], level: 'associate', endDate: '2026-01' },
      ],
    });
    expect(deriveProfile(toDraftProfile(enrolled, NOW), NOW).seniorityBand).toBe('pre_college');
  });
});

// ─────────────────────────────────────────── nearly empty

describe('nearly-empty resume', () => {
  const p = confirm(EMPTY);
  const ev = retrieveEvidence(p, 'Tell us about yourself.', { limit: 20 });
  const det = (c: string) => checkClaimDeterministically(c, ev);

  it('measures service and membership durations like any other work', () => {
    for (const c of [
      'I have volunteered at the Sample Community Food Pantry for five years.',
      'I have been a member of the Chess Club for ten years.',
      'I have served at the Sample Community Food Pantry for five years.',
      'I have worked at the Sample Community Food Pantry for five years.',
    ]) {
      expect(
        guardDraft(c, ev).blocking.some((x) => x.verdict === 'overstated'),
        c,
      ).toBe(true);
    }
  });

  /** Students write their state out in essays; resumes abbreviate it. One place. */
  it('accepts the home state spelled out or abbreviated', () => {
    expect(guardDraft('I live in Springfield, Ohio.', ev).blocking).toEqual([]);
    expect(guardDraft('I live in Springfield, OH.', ev).blocking).toEqual([]);
  });

  it('still blocks a state the profile does not hold', () => {
    expect(det('I grew up in Nevada before moving here.').verdict).toBe('unsupported');
  });

  it('keeps a "St." sentence whole and unblocked', () => {
    expect(
      splitClaims('I attend St. Sample High School and expect to graduate in 2027.'),
    ).toHaveLength(1);
    expect(det('I am a member of the Chess Club at St. Sample High School.').verdict).toBeNull();
    expect(
      guardDraft('I attend St. Sample High School and expect to graduate in 2027.', ev).blocking,
    ).toEqual([]);
  });

  it('infers no phantom families from chess and a food pantry', () => {
    expect(inferRoleFamilies(p)).toEqual([]);
  });
});

// ─────────────────────────────────────────── awkward edges

describe('awkward edges: St. orgs, homeschool, school named after a taxonomy word', () => {
  const p = confirm(AWKWARD);
  const ev = retrieveEvidence(p, 'Tell us about your service.', { limit: 20 });
  const det = (c: string) => checkClaimDeterministically(c, ev);

  it('keeps "St. Sample Children\'s Hospital" one claim, matched whole', () => {
    expect(
      splitClaims("I have volunteered at St. Sample Children's Hospital since June 2024."),
    ).toHaveLength(1);
    expect(
      det("I have volunteered at St. Sample Children's Hospital since June 2024.").verdict,
    ).toBeNull();
  });

  it('blocks an invented "St. Jude" employer by name, not by accident', () => {
    const g = guardDraft('I interned at St. Jude for three years.', ev);
    expect(g.blocking.some((c) => (c.reason ?? '').includes('Jude'))).toBe(true);
  });

  it('scopes a duration to the St.-prefixed hospital now that the name matches', () => {
    const r = det("I have worked at St. Sample Children's Hospital for five years.");
    expect(r.verdict).toBe('overstated');
    expect(r.reason).toMatch(/26 months/);
  });

  it('measures service-verb durations against the real spans', () => {
    for (const c of [
      'I have volunteered there for eight years.',
      'I have served as a hospital volunteer for eight years.',
      'I have been a member of Scouts BSA Troop 214 for fifteen years.',
    ]) {
      expect(det(c).verdict, c).toBe('overstated');
    }
    // Deliberately permissive boundary: an UNSCOPED six-year service claim passes,
    // because the Scouts entry genuinely spans 67 months and an unscoped claim is
    // measured against the longest matching entry. That is the documented trade.
    expect(det('I have volunteered at the hospital for six years.').verdict).toBeNull();
  });

  it('infers healthcare from the hospital itself', () => {
    expect(inferRoleFamilies(p)).toContain('healthcare');
  });

  /** A school NAME is identity, not role evidence — wherever it appears. */
  it("does not mint design when the school is written as a club's organization", () => {
    const withClub = confirm({
      ...AWKWARD,
      experience: [
        ...AWKWARD.experience,
        {
          organization: 'Design and Architecture Senior High',
          title: 'Student Ambassador',
          type: 'club',
          startDate: null,
          endDate: null,
          location: null,
          bullets: [],
        },
      ],
    });
    expect(inferRoleFamilies(withClub)).not.toContain('design');
  });

  it('flags what derivation cannot rank instead of degrading silently', () => {
    const home = toDraftProfile(
      ResumeExtraction.parse({
        ...AWKWARD,
        education: [
          {
            ...AWKWARD.education[0],
            institution: 'Vega Family Homeschool Cooperative',
            level: 'other',
          },
        ],
      }),
      NOW,
    );
    expect(home.needsReview).toContain('education.0.level');

    const yearOnly = toDraftProfile(
      ResumeExtraction.parse({
        ...AWKWARD,
        education: [{ ...AWKWARD.education[0], startDate: '2023' }],
      }),
      NOW,
    );
    expect(yearOnly.needsReview).toContain('education.0.startDate');
  });
});
