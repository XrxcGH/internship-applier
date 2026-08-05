/**
 * Redline suite — an M6 release gate (docs/07, docs/11).
 *
 * Two halves, and both are load-bearing.
 *
 * The first asserts that every field the tool must never touch is caught. Failing one of
 * these means a machine could sign an attestation or transcribe an SSN.
 *
 * The second asserts that ordinary fields are NOT caught. This matters more than it looks:
 * a blocklist that swallows work-authorization questions and graduation dates turns the
 * skipped-fields list into a wall of noise, and a user who has to hand-fill twenty fields
 * stops reading which ones were skipped and why. Over-blocking defeats the same purpose
 * under-blocking does.
 */
import { describe, expect, it } from 'vitest';
import { checkRedline, describeSkipped, normalizeField } from '../src/core/filling/redlines';

const redline = (label: string, extra: Record<string, string> = {}) =>
  checkRedline({ label, ...extra });

describe('must never be filled', () => {
  const CASES: Array<[string, string]> = [
    // Government and identity
    ['Social Security Number', 'government_id'],
    ['SSN', 'government_id'],
    ['Social Insurance Number (SIN)', 'government_id'],
    ['National Insurance number', 'government_id'],
    ['Taxpayer identification number', 'government_id'],
    ['Passport number', 'government_id'],
    ["Driver's licence number", 'government_id'],
    ['Alien registration number', 'government_id'],
    ['Date of birth', 'government_id'],
    ['DOB', 'government_id'],

    // Financial
    ['Bank account number', 'financial'],
    ['Routing number', 'financial'],
    ['IBAN', 'financial'],
    ['Credit card number', 'financial'],
    ['What was your salary at your last position?', 'financial'],
    ['Current compensation', 'financial'],

    // Credentials
    ['Create a password', 'credential'],
    ['Security question answer', 'credential'],
    ['One-time code', 'credential'],

    // Attestations
    ['I certify the information above is true and complete', 'attestation'],
    ['I attest that all statements are accurate', 'attestation'],
    ['Under penalty of perjury', 'attestation'],
    ['Electronic signature', 'attestation'],
    ['Type your full name to sign', 'attestation'],
    ['Initials', 'attestation'],

    // Consent
    ['I agree to the Terms of Service', 'consent'],
    ['I accept the terms and conditions', 'consent'],
    ['I authorize a background check', 'consent'],
    ['Credit check authorization', 'consent'],
    ['Drug screen consent', 'consent'],
    ['Send me marketing emails', 'consent'],
    ['Send me news and updates', 'consent'],
    ['Opt in to communications', 'consent'],
    ['May we contact your current employer?', 'consent'],

    // EEO and personal
    ['Race / ethnicity', 'eeo_demographic'],
    ['Are you Hispanic or Latino?', 'eeo_demographic'],
    ['Gender', 'eeo_demographic'],
    ['Protected veteran status', 'eeo_demographic'],
    ['Disability status (Form CC-305)', 'eeo_demographic'],
    ['Voluntary self-identification', 'eeo_demographic'],
    ['Religious affiliation', 'eeo_demographic'],
    ['Marital status', 'eeo_demographic'],
    ['Have you ever been convicted of a felony?', 'eeo_demographic'],
    ['Emergency contact phone number', 'eeo_demographic'],

    // Non-US national identifiers. A US-only table is not a defensible place to stop.
    ['Aadhaar Number', 'government_id'],
    ['NRIC / FIN', 'government_id'],
    ['Codice Fiscale', 'government_id'],
    ['Emirates ID', 'government_id'],
    ['Personnummer', 'government_id'],
    ['CPF', 'government_id'],
    ['Tax File Number (TFN)', 'government_id'],
    ['Government-issued ID', 'government_id'],
    ['Work Permit Number', 'government_id'],
    ['Passport expiry date', 'government_id'],

    // International banking, and the autocomplete tokens a form can declare with no label.
    ['BSB', 'financial'],
    ['IFSC Code', 'financial'],
    ['Transit Number', 'financial'],
    ['Voided cheque upload', 'financial'],
    ['cc-number', 'financial'],
    ['Card Security Code', 'financial'],
    ['PayPal email', 'financial'],

    // Security-question answers: phrased as harmless trivia, but they unlock recovery.
    ["Mother's maiden name", 'credential'],
    ['Name of your first pet', 'credential'],
    ['Street you grew up on', 'credential'],
    ['Authenticator app code', 'credential'],
    ['Create a username', 'credential'],
    ['Passphrase', 'credential'],

    // Attestation, in the third person and in other jurisdictions' vocabulary.
    ['The applicant certifies', 'attestation'],
    ['Statement of Truth', 'attestation'],
    ['Affidavit', 'attestation'],
    ['This declaration must be notarised', 'attestation'],
    ['DocuSign', 'attestation'],
    ['Please sign below', 'attestation'],

    // AI disclosure
    ['Did you use AI to write any part of this application?', 'ai_disclosure'],
    ['Was artificial intelligence used to generate this response?', 'ai_disclosure'],
    ['Did you use ChatGPT for this application?', 'ai_disclosure'],
  ];

  for (const [label, category] of CASES) {
    it(`catches "${label}"`, () => {
      const r = redline(label);
      expect(r, label).not.toBeNull();
      expect(r!.category, label).toBe(category);
      expect(r!.note.length, label).toBeGreaterThan(10);
    });
  }

  it('catches a password field however it is labelled', () => {
    // The browser's own type attribute outranks any label. A field labelled "Passphrase"
    // or mislabelled entirely is still a password field.
    const r = checkRedline({ label: 'Choose a memorable phrase', type: 'password' });
    expect(r?.category).toBe('credential');
  });

  it('catches a redline hiding behind a meaningless name attribute', () => {
    // The Greenhouse pattern: label carries the meaning, name is a generated id.
    const r = checkRedline({ label: 'Taxpayer identification number', name: 'q_7781' });
    expect(r?.category).toBe('government_id');
  });

  it('catches a redline whose meaning is only in the name attribute', () => {
    // And the inverse: no usable label, but the name gives it away.
    const r = checkRedline({ label: '', name: 'eeo_race', id: 'race' });
    expect(r?.category).toBe('eeo_demographic');
  });

  it('raises the AI question rather than skipping it silently', () => {
    const r = redline('Did you use AI to write any part of this application?');
    expect(r!.note).toMatch(/answer it yourself/i);
    expect(describeSkipped([r!])).toMatch(/asks about AI use/i);
  });
});

describe('must still be filled', () => {
  const ORDINARY = [
    'First name',
    'Last name',
    'Preferred name',
    'Email address',
    'Mobile phone',
    'Street address',
    'City',
    'State',
    'Zip code',
    'LinkedIn profile',
    'GitHub URL',
    'Portfolio website',
    'University',
    'Degree',
    'Major / field of study',
    'GPA',
    'Expected graduation date',
    'Earliest start date',
    'Hours available per week',
    'How did you hear about us?',
    'Tell us about a project you are proud of.',
    'Why do you want to work here?',
    'Upload your resume',
    'Cover letter',
    'Desired location',
    'Are you willing to relocate?',
    'Major: Marketing',
    // A username qualified by a public platform is a profile link, not a credential.
    'GitHub username',
    'LinkedIn username',
    'Portfolio username',
    // A professional certification is a resume item, not a sworn statement.
    'Certification name',
    'Professional certifications',
    // And an academic declaration is not a legal one.
    'Declaration of major',
    'Marketing',
  ];

  for (const label of ORDINARY) {
    it(`leaves "${label}" alone`, () => {
      expect(redline(label), label).toBeNull();
    });
  }

  it('fills work authorization, which is the whole point of the tool', () => {
    // These overlap heavily with citizenship and visa vocabulary, so they are the
    // likeliest false positives in the whole table.
    for (const label of [
      'Are you legally authorized to work in the United States?',
      'Will you now or in the future require sponsorship for employment visa status?',
      'Do you require sponsorship?',
      'Work authorization status',
      'Are you eligible to work in the UK?',
    ]) {
      expect(redline(label), label).toBeNull();
    }
  });

  it('does not mistake a graduation or start date for a date of birth', () => {
    expect(redline('Expected graduation date')).toBeNull();
    expect(redline('Anticipated graduation date')).toBeNull();
    expect(redline('Available start date')).toBeNull();
    // But the real thing is still caught.
    expect(redline('Date of birth')?.category).toBe('government_id');
  });

  it('does not mistake salary EXPECTATION for salary history', () => {
    // Expectation is forward-looking and answerable from the profile; history is not.
    expect(redline('Salary expectation')).toBeNull();
    expect(redline('Desired compensation')).toBeNull();
    expect(redline('Current salary')?.category).toBe('financial');
  });
});

describe('normalization', () => {
  it('joins the places a form hides meaning', () => {
    expect(normalizeField({ label: 'Social Security Number', name: 'q_1' })).toBe(
      'social security number q 1',
    );
  });

  it('flattens separators so name attributes match prose patterns', () => {
    expect(normalizeField({ name: 'drivers_license-number' })).toBe('drivers license number');
  });

  it('survives a field with nothing to go on', () => {
    expect(normalizeField({})).toBe('');
    expect(checkRedline({})).toBeNull();
  });
});
