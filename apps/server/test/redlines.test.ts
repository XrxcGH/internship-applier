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

const redline = (label: string) => checkRedline({ label });

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
    // The identifier senses of "numero de", which is the phrase that has to keep working
    // now that it no longer matches on its own.
    ['Número de Seguridad Social', 'government_id'],
    ['Numero de identidad', 'government_id'],
    ['Numéro de sécurité sociale', 'government_id'],

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

    // Health disclosure, in every phrasing the pattern claims to cover. "Medical" needs a
    // second word to separate a health question from "Medical school", and each of those
    // second words has to be checked in both numbers — see the plural block below for why.
    ['Medical condition', 'eeo_demographic'],
    ['Do you have any medical conditions?', 'eeo_demographic'],
    ['Medical history', 'eeo_demographic'],
    ['Medical histories', 'eeo_demographic'],
    ['Medical information', 'eeo_demographic'],
    ['Medical leave', 'eeo_demographic'],
    ['Medical leaves', 'eeo_demographic'],
    ['Medical record', 'eeo_demographic'],
    ['Medical records', 'eeo_demographic'],
    ['Medical exam', 'eeo_demographic'],
    ['Medical exams', 'eeo_demographic'],
    ['Medical examination', 'eeo_demographic'],
    ['Medical examinations', 'eeo_demographic'],
    ['Medical screening', 'eeo_demographic'],
    ['Medical screenings', 'eeo_demographic'],
    ['Health condition', 'eeo_demographic'],
    ['Health conditions', 'eeo_demographic'],

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
    // A middle initial is a name, not a signature.
    'Middle initial',
    'First initial',
    // "Medical" only means a health disclosure with a second word behind it, and "school"
    // is not one of them in either number.
    'Medical school',
    'Medical schools',
    // On a Spanish or French form, "numero de" is how you ask for a phone number.
    'Numero de telefono',
    'Número de teléfono',
    'Numéro de téléphone',
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

/**
 * Plurals, which are not a detail.
 *
 * Several patterns pair a broad word with a narrower one to pin down the dangerous sense —
 * `medical condition` rather than bare `medical`, `background check` rather than bare
 * `background`. Every such pattern is one `\b` away from covering only half the labels it
 * looks like it covers, and the half it loses is the one forms use more: a page says
 * "Medical conditions", "Background checks", "Security questions". A singular-only list
 * reads as if the field is protected while the plural walks straight through it, which is
 * the worst kind of gap because nothing about the pattern looks wrong.
 *
 * So each of these is asserted in both numbers, and the block below asserts that widening
 * did not start swallowing ordinary plural labels.
 */
describe('plural labels are caught too', () => {
  const BOTH_NUMBERS: Array<[string, string, string]> = [
    ['Medical condition', 'Medical conditions', 'eeo_demographic'],
    ['Health condition', 'Health conditions', 'eeo_demographic'],
    ['Political affiliation', 'Political affiliations', 'eeo_demographic'],
    ['Emergency contact', 'Emergency contacts', 'eeo_demographic'],
    ['Protected veteran', 'Protected veterans', 'eeo_demographic'],
    ['Background check', 'Background checks', 'consent'],
    ['Background screening', 'Background screenings', 'consent'],
    ['Drug test', 'Drug tests', 'consent'],
    ['Credit check', 'Credit checks', 'consent'],
    ['Consumer report', 'Consumer reports', 'consent'],
    ['Security question', 'Security questions', 'credential'],
    ['Verification code', 'Verification codes', 'credential'],
    ['One-time password', 'One-time passwords', 'credential'],
    ['Bank account', 'Bank accounts', 'financial'],
    ['Account number', 'Account numbers', 'financial'],
    ['Voided cheque', 'Voided cheques', 'financial'],
    ['Work permit', 'Work permits', 'government_id'],
    ['ID document', 'ID documents', 'government_id'],
    ['Alien registration number', 'Alien registration numbers', 'government_id'],
    ['Applicant declaration', 'Applicant declarations', 'attestation'],
    ['Certification statement', 'Certification statements', 'attestation'],
    ['Signature', 'Signatures', 'attestation'],
  ];

  for (const [singular, plural, category] of BOTH_NUMBERS) {
    it(`catches "${singular}" and "${plural}"`, () => {
      expect(redline(singular)?.category, singular).toBe(category);
      expect(redline(plural)?.category, plural).toBe(category);
    });
  }

  it('does not start refusing ordinary fields that happen to be plural', () => {
    // The other direction. Widening a redline is only safe if it stops at the plural of the
    // same word, and these are the labels closest to the ones just widened.
    for (const label of [
      'Medical schools',
      'GitHub usernames',
      'LinkedIn usernames',
      'Salary expectations',
      'Middle initials',
      'Professional certifications',
      'Certification names',
      'Cover letters',
    ]) {
      expect(redline(label), label).toBeNull();
    }
  });

  it('catches a card expiry field that never says "credit card"', () => {
    // The stem `expir` followed by a word boundary matched no real label at all, so a
    // checkout-style "Card expiration date" was left looking like an ordinary date.
    expect(redline('Card expiration date')?.category).toBe('financial');
    expect(redline('Card expiry')?.category).toBe('financial');
  });

  it('catches the bare "Disability" label EEO sections actually use', () => {
    expect(redline('Disability')?.category).toBe('eeo_demographic');
    expect(redline('Disability status')?.category).toBe('eeo_demographic');
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
