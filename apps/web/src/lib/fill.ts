import type { SkippedField } from './api';

/**
 * The two decisions the fill review makes about a run it is only reading about: which page
 * the report is really describing, and why a field was left for the user.
 *
 * Both are here rather than in the component because both are the kind of thing that looks
 * obviously right and is not — a string comparison that fires on a trailing slash, a lookup
 * that renders nothing for a value it has not heard of.
 */

/**
 * Whether two addresses point at the same page.
 *
 * A browser turns a bare origin into one with a trailing slash, so comparing the strings as
 * they arrive would announce "the form was read from somewhere else" on every run whose
 * apply URL happened to have no path — and a warning that fires when nothing is wrong is one
 * people learn to click past, including on the run where the browser really did end up on a
 * different posting. A trailing empty fragment is the same story.
 */
export function samePage(a: string, b: string): boolean {
  const bare = (u: string) => u.trim().replace(/[/#]+$/, '');
  return bare(a) === bare(b);
}

/** Why a field was left for the user, in the words the review list already uses. */
const SKIP_REASON: Record<SkippedField['reason'], string> = {
  redline: 'This tool never fills one of these in for you.',
  unclassified: 'The tool could not work out what this field wanted.',
  no_match: 'Nothing in your profile answers this one.',
  /**
   * `failed` covers both a field the tool could not type into and one where reading the
   * value back gave something other than what was typed. It is the one reason that does not
   * mean "the box is untouched", and saying it did would walk someone past a box holding
   * half a sentence.
   */
  failed:
    'The tool tried and could not get your answer in, so whatever is in that box may be wrong.',
};

/** Why one skipped field was left, naming the redline where the record names one. */
export function skipReason(f: SkippedField): string {
  if (f.reason === 'redline' && f.category) {
    return `A ${f.category.replace(/_/g, ' ')} question. ${SKIP_REASON.redline}`;
  }
  // A record written by a version that knew a reason this one does not still has to say
  // something, because a row with no explanation beside it reads as a field needing nothing.
  return SKIP_REASON[f.reason] ?? 'The tool did not fill this one in.';
}
