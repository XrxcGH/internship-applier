/**
 * Which review flags may be waved off, and which have to be answered instead.
 *
 * Gate G1 refuses to confirm a profile while anything is still flagged, so every flag needs
 * a way off the list. For a flag nothing in this app can answer — anything nested in
 * education or experience — that way is the "I have checked this" button, and without it G1
 * locks shut with no way forward. For a flag that DOES have somewhere to be answered, the
 * same button is a way to mark a fact reviewed while leaving it blank: one click on
 * `dateOfBirth` and G1 confirms a profile with no date of birth in it, which then puts every
 * 18+ posting in the "check this" band for ever with nothing on screen saying why.
 *
 * So: a flag is dismissible only where there is nowhere to answer it.
 *
 * The wizard hides the button for the paths below, and this module is the same rule on the
 * server, because a client-side rule is a suggestion — the endpoint behind that button is
 * one curl away, and it used to drop the flag whatever the field held.
 *
 * The web wizard keeps its own copy of this list in apps/web/src/lib/review.ts, beside the
 * controls it names. A new control on the wizard needs its path added in both places on the
 * same day.
 */
import type { CandidateProfile } from '@ia/shared';

/**
 * Flagged paths that have a control somewhere, and what to call each one in a refusal.
 *
 * These are the six facts a resume never contains (REQUIRED_BY_G1 in ingestion/toProfile.ts)
 * plus the three contact fields the extractor flags when it could not read them.
 */
export const ANSWERED_IN_WIZARD: Record<string, string> = {
  fullName: 'Your name',
  email: 'Your email address',
  phone: 'Your phone number',
  dateOfBirth: 'Your date of birth',
  'workAuthorization.status': 'Your work authorization',
  'availability.start': 'The date you can start',
  'availability.end': 'The date you have to finish',
  'locationPrefs.base.city': 'Your home city',
  'locationPrefs.base.region': 'Your home state',
};

/**
 * Whether a flagged profile field now holds a real answer.
 *
 * "Unanswered" is not one shape. The work-authorization enum spells its own placeholder as
 * the string `unknown`, the text fields store an empty string, and the two date fields are
 * null or absent once the picker is cleared. A predicate that only understood strings
 * treated a cleared date as an answer, which is the same hole by another route.
 */
export function isAnswered(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  // An empty list is not an answer to "the reader found none of these" — the same rule the
  // web copy carries, and for the same reason: every non-string counted as answered, so the
  // `skills` corpus flag cleared on any touch of the skills editor, including a touch that
  // was immediately undone.
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  return trimmed !== '' && trimmed !== 'unknown';
}

/** Reads a dotted flag path out of the profile, so the rule can check its own field. */
function valueAt(profile: CandidateProfile, path: string): unknown {
  return path.split('.').reduce<unknown>((o, key) => {
    if (o === null || typeof o !== 'object') return undefined;
    return (o as Record<string, unknown>)[key];
  }, profile);
}

/**
 * Why this flag may not be dropped yet, or null if it may.
 *
 * A flag with nowhere to be answered is always dismissible; one with somewhere is
 * dismissible only once that somewhere holds a value.
 */
export function dismissalRefusal(profile: CandidateProfile, path: string): string | null {
  const label = ANSWERED_IN_WIZARD[path];
  if (label === undefined) return null;
  if (isAnswered(valueAt(profile, path))) return null;
  return (
    `${label} can be answered directly, so this flag cannot be marked reviewed while the ` +
    `field is still empty. Save a value for "${path}" first — this call will clear the flag ` +
    'once there is one.'
  );
}
