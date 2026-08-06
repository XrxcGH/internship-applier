/**
 * Field classification. Deterministic stage only — no model runs here.
 *
 * The interesting assertions are the ones about ORDER and about refusing to guess. A rule
 * table is easy to write and easy to get subtly wrong: "name" swallows "school name",
 * "state" swallows nothing until someone adds a "current state of employment" field, and
 * a default of `text` would quietly type a phone number into whatever came last.
 */
import { describe, expect, it } from 'vitest';
import { classifyField, isActionable, CONFIDENCE_FLOOR } from '../src/core/filling/classify';

const of = (label: string, extra = {}) => classifyField({ label, ...extra });

describe('recognizes ordinary fields', () => {
  const CASES: Array<[string, string]> = [
    ['First name', 'first_name'],
    ['Given name', 'first_name'],
    ['Last name', 'last_name'],
    ['Surname', 'last_name'],
    ['Full legal name', 'full_name'],
    ['Email address', 'email'],
    ['Mobile phone', 'phone'],
    ['Street address', 'address_line1'],
    ['City', 'city'],
    ['State / Province', 'region'],
    ['Zip code', 'postal'],
    ['Country', 'country'],
    ['LinkedIn profile', 'linkedin'],
    ['GitHub URL', 'github'],
    ['Portfolio', 'portfolio'],
    ['Personal website', 'portfolio'],
    ['University', 'school'],
    ['Degree', 'degree'],
    ['Field of study', 'major'],
    ['GPA', 'gpa'],
    ['Expected graduation date', 'graduation_date'],
    ['Are you currently enrolled?', 'enrollment_status'],
    ['Are you legally authorized to work in the US?', 'work_auth'],
    ['Will you require sponsorship?', 'sponsorship_needed'],
    ['Upload your resume', 'resume_upload'],
    ['Cover letter', 'cover_letter_upload'],
    ['Official transcript', 'transcript_upload'],
    ['Earliest start date', 'start_date'],
    ['Hours per week', 'hours_available'],
    ['Salary expectation', 'salary_expectation'],
    ['How did you hear about us?', 'referral_source'],
  ];

  for (const [label, semantic] of CASES) {
    it(`reads "${label}" as ${semantic}`, () => {
      const c = of(label);
      expect(c.semantic, label).toBe(semantic);
      expect(c.confidence, label).toBeGreaterThanOrEqual(CONFIDENCE_FLOOR);
    });
  }
});

describe('rule ordering', () => {
  it('does not let the generic name rule swallow the specific ones', () => {
    expect(of('First name').semantic).toBe('first_name');
    expect(of('Last name').semantic).toBe('last_name');
    // A school field mentioning "name" must stay a school.
    expect(of('School name').semantic).toBe('school');
    expect(of('University name').semantic).toBe('school');
  });

  it('prefers sponsorship over the broader work-authorization rule', () => {
    // "Will you require sponsorship for employment visa status?" contains both ideas.
    expect(of('Will you now or in the future require sponsorship?').semantic).toBe(
      'sponsorship_needed',
    );
    expect(of('Are you legally authorized to work?').semantic).toBe('work_auth');
  });

  it('prefers a specific link host over the generic website rule', () => {
    expect(of('LinkedIn URL').semantic).toBe('linkedin');
    expect(of('GitHub website').semantic).toBe('github');
    expect(of('Other website').semantic).toBe('website');
  });

  it('reads transcript as an upload rather than a school field', () => {
    expect(of('Upload your transcript').semantic).toBe('transcript_upload');
  });
});

describe('the autocomplete attribute wins', () => {
  it('is trusted over a misleading label', () => {
    // The form declared what this is. That beats prose.
    const c = classifyField({ label: 'Name', autocomplete: 'family-name' });
    expect(c.semantic).toBe('last_name');
    expect(c.via).toBe('autocomplete');
    expect(c.confidence).toBeGreaterThan(0.95);
  });

  it('ignores tokens whose meaning is ambiguous on an application', () => {
    // `organization` could be the current employer or the school. Guessing between them
    // is exactly the mistake worth not making, so it falls through to the rules.
    const c = classifyField({ label: 'University', autocomplete: 'organization' });
    expect(c.semantic).toBe('school');
    expect(c.via).toBe('rule');
  });
});

describe('refusal outranks recognition', () => {
  it('classifies a redline as REDLINE even when it looks fillable', () => {
    const c = of('Social Security Number');
    expect(c.semantic).toBe('REDLINE');
    expect(c.via).toBe('redline');
    expect(isActionable(c)).toBe(false);
  });

  it('refuses a password field whatever its label claims', () => {
    const c = classifyField({ label: 'Email', type: 'password' });
    expect(c.semantic).toBe('REDLINE');
  });

  it('does not let a placeholder alone unlock a sensitive field', () => {
    // A placeholder is a weak signal, so it is excluded from the redline haystack. The
    // label and name still catch this one.
    const c = classifyField({ label: 'Identifier', name: 'ssn', placeholder: 'e.g. 123-45-6789' });
    expect(c.semantic).toBe('REDLINE');
  });
});

describe('refuses to guess', () => {
  it('returns unknown rather than defaulting', () => {
    for (const label of ['Question 14', 'q_9812', 'Additional field', '']) {
      const c = of(label);
      expect(c.semantic, label).toBe('unknown');
      expect(isActionable(c), label).toBe(false);
    }
  });

  it('survives a field with no describing attributes at all', () => {
    const c = classifyField({});
    expect(c.semantic).toBe('unknown');
    expect(c.via).toBe('none');
  });
});

describe('essay detection by shape, not keyword', () => {
  it('recognizes a long-form question whatever it asks about', () => {
    expect(
      classifyField({ label: 'Tell us about a time you changed your mind.', type: 'textarea' })
        .semantic,
    ).toBe('essay');
    expect(
      classifyField({ label: 'What would you build with a free week?', type: 'textarea' }).semantic,
    ).toBe('essay');
  });

  it('does not call a short text input an essay', () => {
    expect(classifyField({ label: 'City', type: 'text' }).semantic).toBe('city');
  });

  it('does not call a labelled textarea an essay when the label names a known field', () => {
    // Cover letter pasted into a textarea is still a cover letter.
    expect(classifyField({ label: 'Cover letter', type: 'textarea' }).semantic).toBe(
      'cover_letter_upload',
    );
    expect(classifyField({ label: 'Paste your resume below', type: 'textarea' }).semantic).toBe(
      'resume_upload',
    );
  });

  /**
   * The ordering assertion that matters most, because getting it wrong is silent.
   *
   * An essay prompt is allowed to MENTION anything. When the rule table ran first, every
   * prompt containing a word from it was answered with that word's value: a 600-character
   * box asking about a leadership role in college received the string "Cornell University",
   * and the answer the user had written and approved for that question was dropped without
   * a skip or a note.
   */
  it('is not fooled by a keyword the essay question merely mentions', () => {
    const PROMPTS = [
      'Why are you interested in interning at LinkedIn?',
      'Describe a project you are proud of. Feel free to include a GitHub link.',
      'Share a link to something you have built (GitHub, portfolio, etc.) and describe it.',
      'Why did you choose your university and major?',
      'Why did you choose your major?',
      'Describe a leadership role you have held in college.',
      'What have you learned outside of school that prepares you for this role?',
      'What is the most interesting class you have taken at university?',
      'Please describe any relevant coursework or school activities.',
      'What excites you about working at our college sports startup?',
      'Tell us about your salary expectations and why.',
    ];
    for (const label of PROMPTS) {
      expect(classifyField({ label, control: 'textarea' }).semantic, label).toBe('essay');
      // Rich text boxes carry no `type` at all, so they have to be checked separately.
      expect(classifyField({ label, control: 'richtext' }).semantic, label).toBe('essay');
    }
  });

  it('leaves a wordy question on a short control to the rules', () => {
    // A long label is the weakest essay signal, and a dropdown asking this in seventy-six
    // characters is still a yes/no the profile can answer.
    const sponsorship =
      'Will you now or in the future require sponsorship for employment visa status?';
    expect(sponsorship.length).toBeGreaterThan(60);
    expect(classifyField({ label: sponsorship, control: 'select' }).semantic).toBe(
      'sponsorship_needed',
    );
    expect(
      classifyField({
        label: 'Are you legally authorized to work in the United States? Please answer yes or no.',
        control: 'select',
      }).semantic,
    ).toBe('work_auth');
  });
});

/**
 * Where someone was born, and where they hold citizenship, are not where they get their post.
 *
 * The city and country rules matched the word anywhere in the label, so "City of birth" was
 * filled with the city the user currently lives in and "Country of Citizenship" with the
 * country of their home address — for a permanent resident, a false statement about their
 * immigration status, entered at high confidence and reported back as a field successfully
 * filled. `unknown` is the right answer: nothing in the profile answers these, so the box is
 * left empty and handed to the user.
 */
describe('origin questions are not the mailing address', () => {
  const NOT_ADDRESS = [
    'City of birth',
    'Country of birth',
    'Birth city',
    'Birth country',
    'Town of birth',
    'City/Town of Birth',
    'State of birth',
    'Country of Citizenship',
    'What is your country of citizenship?',
    'Country of nationality',
    'Dual citizenship country',
    'Country of national origin',
  ];

  for (const label of NOT_ADDRESS) {
    it(`leaves "${label}" for the user`, () => {
      const c = of(label);
      expect(c.semantic, label).toBe('unknown');
      expect(isActionable(c), label).toBe(false);
    });
  }

  it('is not talked round by an address autocomplete token', () => {
    // A form that declares `autocomplete="country"` on a birthplace box has answered a
    // different question than the one printed above it.
    const c = classifyField({ label: 'Country of birth', autocomplete: 'country' });
    expect(c.semantic).toBe('unknown');
    expect(isActionable(c)).toBe(false);
  });

  it('still fills an ordinary address', () => {
    expect(of('City').semantic).toBe('city');
    expect(of('Country').semantic).toBe('country');
    expect(of('State / Province').semantic).toBe('region');
    expect(of('Zip code').semantic).toBe('postal');
    expect(of('Street address').semantic).toBe('address_line1');
    expect(classifyField({ label: 'Country', autocomplete: 'country' }).via).toBe('autocomplete');
  });
});
