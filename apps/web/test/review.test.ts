import { describe, expect, it } from 'vitest';
import { isAnswered } from '../src/lib/review';

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
