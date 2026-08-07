/**
 * The FormField shape, and the container hint that lets two identically-labelled questions
 * be told apart.
 *
 * A work-history row's "Start Date" column and the "Start date" this internship asks about
 * are the same string. With nothing but the label to go on, the availability date gets typed
 * into a row of the applicant's employment history at high confidence and read back as
 * correct — a false statement about their work history in a form submitted in their name.
 */
import { describe, expect, it } from 'vitest';
import { FormField } from '../src/application';

const base = {
  id: 'f1',
  locator: '#start',
  label: 'Start Date',
  control: 'date',
  required: false,
  semantic: 'start_date',
  confidence: 0.92,
};

describe('FormField', () => {
  it('carries the container a control sits in', () => {
    const parsed = FormField.safeParse({ ...base, section: 'Employment History' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.section).toBe('Employment History');
  });

  /**
   * Optional, because no scanner sets it yet. It must stay absent rather than defaulting to
   * a string: anything reading it has to be able to tell "no container known" from a real
   * heading, and a default would answer that question wrongly for every field on the page.
   */
  it('leaves the container undefined rather than inventing one', () => {
    const parsed = FormField.safeParse(base);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.section).toBeUndefined();
  });

  it('refuses a container that is not text', () => {
    expect(FormField.safeParse({ ...base, section: 3 }).success).toBe(false);
  });
});
