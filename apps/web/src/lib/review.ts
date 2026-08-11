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
  // An empty list is not an answer to "the reader found none of these". Every non-string
  // counted as answered, so the `skills` corpus flag — raised when an extraction came back
  // with no skills at all — cleared on ANY touch of the skills editor: add a skill, remove
  // it again, and the net change is nothing while the flag is gone, `remaining` drops, and
  // Confirm unlocks. That is the touch-and-undo hole this predicate exists to close, one
  // type over. It also means emptying the list puts the flag back, which is the same rule
  // read in the other direction.
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  return trimmed !== '' && trimmed !== 'unknown';
}

/**
 * The flagged paths the onboarding wizard has a REQUIRED input for, and where that input is.
 *
 * The other half of the same rule. `isAnswered` above stops a flag from clearing when the
 * field is still empty; this stops the "I have checked this" button from clearing one
 * regardless. That button posts to an endpoint that drops the flag — but only where the
 * field is not one of these paths: the server now refuses dismissal (409 ANSWER_REQUIRED,
 * `dismissalRefusal` in core/profile/reviewFlags.ts) for these same paths while they are
 * still empty, so a client that tried anyway is turned away. Hiding the button here is the
 * presentation of that rule, not the guard itself. Without both, beside a field with a
 * control the button was a way to mark a fact reviewed while leaving it blank — one click on
 * `dateOfBirth` and G1 would confirm a profile with no date of birth in it.
 *
 * The button still exists for flags nothing on the wizard can answer — anything nested in
 * education or experience — because without it G1 locks shut with no way forward.
 *
 * So: a flag on a REQUIRED wizard control is never dismissible, and its blank must be typed
 * away. A new required control needs its path added here on the same day. A wizard control
 * whose blank is itself a valid answer goes in `OPTIONAL_WIZARD_FIELDS` below instead — it
 * stays dismissible, because there is no missing fact to confirm and forcing a value would
 * lock G1 against a person who has nothing to put there.
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

/**
 * Wizard controls whose blank is itself a complete answer.
 *
 * The clears rule in Onboarding re-flags a field left empty, which is right for the required
 * facts above — an empty home city is a fact still missing. Pronouns is not one of those: a
 * person with no pronouns to give has answered by leaving it blank, so it is NOT in
 * ANSWERED_IN_WIZARD (it stays dismissible, or a blank-happy user could never clear the flag
 * and G1 would lock shut) and its flag clears the moment the control is touched, whatever it
 * then holds. A new optional control on the wizard needs its path listed here so the two
 * halves — the control and the rule — stay in step.
 */
export const OPTIONAL_WIZARD_FIELDS = new Set<string>(['pronouns']);

/** Whether this flag may be waved off, or has to be answered on a required control instead. */
export function isDismissible(path: string): boolean {
  return ANSWERED_IN_WIZARD[path] === undefined;
}
