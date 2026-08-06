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
