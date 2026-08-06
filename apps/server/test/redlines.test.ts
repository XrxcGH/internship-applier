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
    // "Range" attached to an unambiguous expectation word is still an expectation question,
    // and so is an expectation question about what you want at the moment.
    expect(redline('Desired salary range')).toBeNull();
    expect(redline('Expected salary range')).toBeNull();
    expect(redline('Target pay rate')).toBeNull();
    expect(redline('What are your current salary expectations?')).toBeNull();
    expect(redline('Current salary expectation')).toBeNull();
    expect(redline('What salary range are you currently seeking?')).toBeNull();
  });

  it('still fills a work permit STATUS question, which is about eligibility', () => {
    // The identity-document pattern cannot tell "do you hold one?" from "give us the
    // document", and this is the one work-eligibility phrasing that needs the distinction
    // made for it.
    expect(redline('Work permit status')).toBeNull();
    expect(redline('Work visa status')).toBeNull();
  });
});

/**
 * The reach of the allowlist, pinned in both directions.
 *
 * Every label in the first block pairs a phrase the allowlist claims with vocabulary it has
 * no business excusing. The allowlist used to be consulted before the redline table and
 * cancel all of it, so the checkbox "I certify that I am legally authorized to work in the
 * United States" — ordinary closing boilerplate on a US application form — was not read as an
 * attestation at all. It was classified as a work-authorization question and ticked "Yes",
 * which is a machine swearing a legal statement in the applicant's name.
 *
 * The second block is the other half and matters just as much: the plain phrasings the
 * allowlist exists for have to stay fillable. A fix that overshoots hands the user their own
 * eligibility question to answer by hand on every application, which is how the ordering that
 * caused all this got written in the first place.
 */
/**
 * The verb list is the soft spot in the attestation rule, so it gets its own block.
 *
 * Scoping the allowlist fixed the "I certify …" checkboxes, but the rule still only
 * recognises the statement by its verb — and "confirm" was not on the list, so "By checking
 * this box I confirm I am authorized to work in the US" classified as an ordinary
 * work-authorization question at 0.94 and got ticked. Same harm as the case that was fixed,
 * reached through a phrasing that is at least as common.
 */
describe('every way of saying "I swear this is true"', () => {
  const ATTESTATIONS = [
    'By checking this box I confirm I am authorized to work in the US',
    'I verify that the information above is accurate',
    'I warrant that all statements are true',
    'I represent that I am eligible for employment',
    'I certify that I am legally authorized to work in the United States',
    'I acknowledge that false statements may result in dismissal',
    'The applicant affirms that the above is correct',
    'I declare under penalty of perjury that this is true',
  ];

  for (const label of ATTESTATIONS) {
    it(`refuses to answer for the user: "${label.slice(0, 48)}…"`, () => {
      expect(checkRedline({ label })?.category).toBe('attestation');
    });
  }

  /** Widening the verbs must not start catching ordinary questions. */
  it('leaves ordinary fields alone', () => {
    for (const label of [
      'Confirm your email address',
      'Professional certifications',
      'Are you legally authorized to work in the United States?',
      'Declared major',
    ]) {
      expect(checkRedline({ label }), label).toBeNull();
    }
  });
});

describe('an allowlisted phrase cancels only its own category', () => {
  const COMBINED: Array<[string, string]> = [
    ['I certify that I am legally authorized to work in the United States', 'attestation'],
    ['I certify under penalty of perjury that I am authorized to work in the US', 'attestation'],
    ['I attest that I am legally authorized to work in the United States', 'attestation'],
    ['Signature: I certify I am legally authorized to work in the US', 'attestation'],
    ['I authorize this background check and confirm my work authorization status', 'consent'],
    ['I consent to a background check and am authorized to work in the US', 'consent'],
    // Stacked labels, where the allowlisted phrase is only one clause of several.
    [
      'I agree to receive marketing emails and I certify I am authorized to work in the US',
      'attestation',
    ],
    ['Race / ethnicity (used only to confirm work authorization status)', 'eeo_demographic'],
    // Identity numbers asked alongside an eligibility question.
    ['Are you legally authorized to work in the US? Enter your SSN to verify', 'government_id'],
    ['Work authorization status / Alien registration number', 'government_id'],
    ['Do you require sponsorship? Passport number', 'government_id'],
    ['Expected graduation date and date of birth', 'government_id'],
    // Salary history dressed as an expectation question.
    ['What is your current salary and your expected salary range?', 'financial'],
  ];

  for (const [label, category] of COMBINED) {
    it(`catches "${label}"`, () => {
      expect(redline(label)?.category, label).toBe(category);
    });
  }

  it('still leaves the plain phrasings alone', () => {
    for (const label of [
      'Are you legally authorized to work in the United States?',
      'Will you now or in the future require sponsorship for employment visa status?',
      'Do you require sponsorship?',
      'Work authorization status',
      'Are you eligible to work in the UK?',
      'Expected graduation date',
      'Earliest start date',
      'Salary expectation',
      'Desired compensation',
      'GitHub username',
      'LinkedIn profile URL',
    ]) {
      expect(redline(label), label).toBeNull();
    }
  });

  it('keeps checking the rest of the table after a rescue', () => {
    // "GitHub username" is excused from the credential pattern, and that is all it is
    // excused from — the attestation in the same label still has to stop the fill.
    expect(redline('GitHub username')).toBeNull();
    expect(redline('I certify that this GitHub username is mine')?.category).toBe('attestation');
  });
});

/**
 * Salary HISTORY, which is the question the redline is actually about.
 *
 * Every label here was allowlisted and filled in with the user's minimum acceptable stipend —
 * their lowest number, handed to an employer as a statement of what they are paid today —
 * because the allowlist accepted a bare "range" as proof that the question was
 * forward-looking. Asking these is restricted in several US states, which is the whole reason
 * the redline exists.
 */
describe('salary history is caught however it is phrased', () => {
  const HISTORY = [
    'What is your current salary range?',
    'Current salary range',
    'Previous salary range',
    'Last salary range',
    'Previous compensation range',
    'Current pay range',
    'Current wage range',
    'Salary range at your most recent position',
    'What was the salary range at your most recent position?',
  ];

  for (const label of HISTORY) {
    it(`catches "${label}"`, () => {
      expect(redline(label)?.category, label).toBe('financial');
      expect(redline(label)!.note, label).toMatch(/salary history/i);
    });
  }
});

/**
 * AI disclosure, in the word order forms actually use.
 *
 * The pattern required the AI term to come before the verb, so "Did AI help write this?" was
 * caught and "Was any part of this written with the help of AI?" — the same question, verb
 * first — was not. A missed one is worse than an ordinary missed redline: instead of being
 * raised for the user to answer, it reaches the essay path and is offered to the
 * answer-drafting engine, so the tool ends up writing the applicant's statement about whether
 * the tool wrote anything.
 */
describe('AI disclosure is caught in either word order', () => {
  const ASKED = [
    // AI term first — the order that already worked, kept so the widening cannot lose it.
    'Did AI help write this?',
    'Did you use AI to write any part of this application?',
    'Was artificial intelligence used to generate this response?',
    'Did you use ChatGPT for this application?',
    // Verb first.
    'Was any part of this written with the help of AI?',
    'Was any part of this application written with the help of ChatGPT?',
    'Did you receive help from AI tools in preparing your responses?',
    'Was this essay generated by AI?',
    'Did you receive assistance from a large language model?',
    // No verb at all, just the noun.
    'AI usage disclosure',
  ];

  for (const label of ASKED) {
    it(`catches "${label}"`, () => {
      expect(redline(label)?.category, label).toBe('ai_disclosure');
      expect(redline(label)!.note, label).toMatch(/answer it yourself/i);
    });
  }

  it('does not fire on ordinary labels that share the vocabulary', () => {
    // The widened verb list reaches "assistant", "writing" and "usage", and the widened term
    // list reaches any word ending in "ai". Both halves have to be present to match.
    for (const label of [
      'Have you used Git before?',
      'What software have you used?',
      'Describe your writing experience.',
      'Research assistant',
      'Teaching assistant',
      'Programming languages used',
      'Dubai',
      'Mumbai',
    ]) {
      expect(redline(label), label).toBeNull();
    }
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
