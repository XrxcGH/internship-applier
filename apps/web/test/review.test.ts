import { describe, expect, it } from 'vitest';
import { ANSWERED_IN_WIZARD, isAnswered, isDismissible } from '../src/lib/review';

/**
 * G1 clears a review flag only when the field it names actually holds something. These
 * cases are the four shapes "unanswered" arrives in from the onboarding controls.
 */
describe('isAnswered', () => {
  it('treats a cleared date picker as unanswered', () => {
    // The date inputs store null (date of birth) or undefined (the availability window)
    // when emptied, so a check that only looked at strings let a user type a date, delete
    // it, and confirm a profile that had no date in it at all.
    expect(isAnswered(null)).toBe(false);
    expect(isAnswered(undefined)).toBe(false);
  });

  it('treats an empty or whitespace-only text field as unanswered', () => {
    expect(isAnswered('')).toBe(false);
    expect(isAnswered('   ')).toBe(false);
  });

  it("treats the work-authorization select's own placeholder as unanswered", () => {
    expect(isAnswered('unknown')).toBe(false);
  });

  it('accepts a real value', () => {
    expect(isAnswered('2027-06-01')).toBe(true);
    expect(isAnswered('Boston')).toBe(true);
    expect(isAnswered('citizen')).toBe(true);
  });
});

/**
 * The other half of the same gate. "I have checked this" posts to an endpoint that drops
 * the flag whatever the field holds, so it must never appear beside a field the wizard can
 * answer — otherwise one click marks a fact as reviewed while it is still blank, and G1
 * confirms a profile with a hole in it.
 */
describe('isDismissible', () => {
  it('refuses to wave off any of the six facts G1 exists to collect', () => {
    // These are exactly the six controls on the wizard's facts step. If a control is added
    // or its path changes, this list and ANSWERED_IN_WIZARD change together.
    for (const path of [
      'dateOfBirth',
      'workAuthorization.status',
      'availability.start',
      'availability.end',
      'locationPrefs.base.city',
      'locationPrefs.base.region',
    ]) {
      expect(isDismissible(path)).toBe(false);
      expect(ANSWERED_IN_WIZARD[path]).toBeTruthy();
    }
  });

  it('refuses to wave off the identity fields, which have controls on the step before', () => {
    expect(isDismissible('fullName')).toBe(false);
    expect(isDismissible('email')).toBe(false);
    expect(isDismissible('phone')).toBe(false);
  });

  it('still lets a flag with no control anywhere be cleared, so G1 cannot lock shut', () => {
    // The extractor flags these and the wizard has no input for either, so without the
    // button there is no way past the gate at all.
    expect(isDismissible('experience.0.startDate')).toBe(true);
    expect(isDismissible('education.2.endDate')).toBe(true);
  });
});
