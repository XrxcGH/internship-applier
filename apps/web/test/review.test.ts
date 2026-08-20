import { describe, expect, it } from 'vitest';
import {
  flagLabel,
  ANSWERED_IN_WIZARD,
  isAnswered,
  isDismissible,
  OPTIONAL_WIZARD_FIELDS,
} from '../src/lib/review';

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

  it('refuses to wave off the identity fields the schema insists on', () => {
    // `fullName: z.string()` and `email: EmailAddress` — neither is optional, so a blank is
    // not an answer and the flag has to stay until there is one.
    expect(isDismissible('fullName')).toBe(false);
    expect(isDismissible('email')).toBe(false);
  });

  it('DOES wave off phone, whose blank the schema accepts as an answer', () => {
    // This asserted `false` and was pinning a bug. `phone: z.string().optional()`, so
    // declining to give a number is a complete answer — but the flag raised on clearing the
    // box was non-dismissible, and the server will not confirm a profile while a flag stands.
    // The only way out of G1 was to type a number the user had chosen not to give.
    expect(isDismissible('phone')).toBe(true);
  });

  it('decides on presence in the map, not on whether the hint reads as truthy', () => {
    // The wizard used to make this same call inline, as `ANSWERED_IN_WIZARD[path] ? …`.
    // Every path with an entry has a control on the wizard and must come back
    // non-dismissible whatever its hint says — including a hint written as an empty
    // string, which is falsy but still means there is somewhere to answer the flag.
    for (const path of Object.keys(ANSWERED_IN_WIZARD)) {
      expect(isDismissible(path)).toBe(false);
    }
  });

  it('still lets a flag with no control anywhere be cleared, so G1 cannot lock shut', () => {
    // The extractor flags these and the wizard has no input for either, so without the
    // button there is no way past the gate at all.
    expect(isDismissible('experience.0.startDate')).toBe(true);
    expect(isDismissible('education.2.endDate')).toBe(true);
  });

  it('leaves an optional wizard control dismissible, since its blank is a real answer', () => {
    // Pronouns has a control on the confirm step, but a person with none to give answers by
    // leaving it blank. Forcing it into ANSWERED_IN_WIZARD would drop the button and trap
    // them behind a flag they could never make non-empty, so it stays dismissible — and the
    // two lists must never both claim it.
    for (const path of OPTIONAL_WIZARD_FIELDS) {
      expect(isDismissible(path)).toBe(true);
      expect(ANSWERED_IN_WIZARD[path]).toBeUndefined();
    }
    expect(OPTIONAL_WIZARD_FIELDS.has('pronouns')).toBe(true);
  });
});

/**
 * The sign-off list is the last thing between a student and a confirmed profile, and it was
 * printing schema paths at them: `education.0.gpa`, `experience.2.startDate`. Nine paths had
 * a hint beside them; every flag nested in education or experience had an identifier and a
 * button, and nothing said which box on which row.
 */
describe('flagLabel', () => {
  it('names the field and the row, counting from one', () => {
    // The paths are zero-based and the list on screen is not, so an index printed raw makes
    // the student do the compiler's counting.
    expect(flagLabel('education.0.gpa')).toBe('GPA on your 1st school');
    expect(flagLabel('experience.2.startDate')).toBe('start date on your 3rd job');
    expect(flagLabel('projects.1.description')).toBe('description on your 2nd project');
  });

  it('gets the awkward ordinals right', () => {
    expect(flagLabel('education.10.gpa')).toBe('GPA on your 11th school');
    expect(flagLabel('education.20.gpa')).toBe('GPA on your 21st school');
    expect(flagLabel('education.11.gpa')).toBe('GPA on your 12th school');
  });

  it('reads an un-indexed section path', () => {
    expect(flagLabel('experience.bullets')).toBe('the bullet points in your jobs');
  });

  it('splits a camelCase field it has no name for, rather than printing it raw', () => {
    expect(flagLabel('education.0.someOtherThing')).toBe('some other thing on your 1st school');
  });

  it('hands back anything it cannot read, unchanged', () => {
    // A wrong label is worse than a raw one: it sends the user to the wrong box confidently.
    expect(flagLabel('workAuthorization.status')).toBe('workAuthorization.status');
    expect(flagLabel('locationPrefs.base.city')).toBe('locationPrefs.base.city');
    expect(flagLabel('somethingUnexpected')).toBe('somethingUnexpected');
  });
});
