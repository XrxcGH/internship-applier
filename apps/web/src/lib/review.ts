/**
 * Whether a flagged profile field now holds a real answer.
 *
 * "Unanswered" is not one shape. The work-authorization select stores its own "Select…"
 * placeholder as the string `unknown`, the text fields store an empty string, and the two
 * date fields store null or undefined once the user clears the picker. A predicate that
 * only understood strings treated the cleared date as an answer, so someone could type a
 * date of birth into G1, delete it again, watch the flag disappear, and confirm a profile
 * with no date of birth in it — which then landed every 18+ posting in the "check this"
 * band forever, with nothing on screen saying why.
 */
export function isAnswered(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  return trimmed !== '' && trimmed !== 'unknown';
}

/**
 * The flagged paths the onboarding wizard has an input for, and where that input is.
 *
 * The other half of the same rule. `isAnswered` above stops a flag from clearing when the
 * field is still empty; this stops the "I have checked this" button from clearing one
 * regardless. That button posts to an endpoint which drops the flag whatever the field
 * holds, so beside a field with a control it was a way to mark a fact reviewed while
 * leaving it blank — one click on `dateOfBirth` and G1 would confirm a profile with no
 * date of birth in it. The button exists for flags nothing on the wizard can answer,
 * anything nested in education or experience, because without it G1 locks shut with no way
 * forward.
 *
 * So: a flag is dismissible only where there is nowhere to answer it. A new control on the
 * wizard needs its path added here on the same day.
 */
export const ANSWERED_IN_WIZARD: Record<string, string> = {
  fullName: 'Correct it on the previous step.',
  email: 'Correct it on the previous step.',
  phone: 'Correct it on the previous step.',
  dateOfBirth: 'Fill it in above.',
  'workAuthorization.status': 'Choose one above.',
  'availability.start': 'Fill it in above.',
  'availability.end': 'Fill it in above.',
  'locationPrefs.base.city': 'Fill it in above.',
  'locationPrefs.base.region': 'Fill it in above.',
};

/** Whether this flag may be waved off, or has to be answered on a control instead. */
export function isDismissible(path: string): boolean {
  return ANSWERED_IN_WIZARD[path] === undefined;
}
