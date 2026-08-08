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
 * Whether two addresses point at the same page, for the purpose of a SOFT WARNING.
 *
 * This is deliberately more forgiving than the server's `sameDocument` (core/filling/fill.ts),
 * and the two are NOT the same test — a claim an earlier version of this comment made and the
 * scheme case disproves. The server decides whether to keep TYPING into a page, which is
 * safety-critical, so it compares origin (scheme included) and path and treats an http→https
 * move as a different document. This function decides only whether to show the user a "the
 * page moved" note, where the failure that matters is the opposite one: a warning that fires
 * when nothing is wrong is one people learn to click past, including on the run where the
 * browser really did land on a different posting.
 *
 * So the benign address changes are folded away here even though the server would not fold
 * them: a bare origin arrives with a trailing slash the path form lacks; a link saved as
 * `http://` is upgraded to `https://` on load; a host is capitalised in one place and not the
 * other; a Greenhouse or Lever board appends `?gh_src=…`/`?source=…` the moment the form
 * opens. None of those changes the page, so comparing host and path (case-folded, scheme- and
 * query-agnostic) keeps the warning for a genuinely different host or path, a login redirect,
 * a further step into a wizard. A different subdomain (`www.` vs bare) is left as a real
 * difference: it can serve different content.
 *
 * The consequence of the divergence, stated plainly: on an http→https move the server may
 * stop the fill while this screen stays quiet. That is the safe direction — the run halts and
 * the pre-submit review shows nothing was submitted — but it is a gap worth knowing about,
 * not the parity the old comment promised.
 *
 * An address that will not parse falls back to the trailing-slash/fragment trim, so a
 * malformed record gets some comparison rather than warning on every run.
 */
export function samePage(a: string, b: string): boolean {
  const norm = (u: string): string | null => {
    try {
      const url = new URL(u.trim());
      const scheme = url.protocol === 'http:' || url.protocol === 'https:' ? 'web:' : url.protocol;
      return `${scheme}//${url.host}${url.pathname}`;
    } catch {
      return null;
    }
  };
  const na = norm(a);
  const nb = norm(b);
  if (na === null || nb === null) {
    const bare = (u: string) => u.trim().replace(/[/#]+$/, '');
    return bare(a) === bare(b);
  }
  return na === nb;
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
