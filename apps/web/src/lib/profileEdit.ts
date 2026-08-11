/**
 * Pure helpers behind the G1 editors.
 *
 * They live outside the components because each one decides something the profile schema
 * will refuse on the way to the server, and a refusal at G1 arrives as "Profile did not
 * match the expected shape" naming no field at all. Deciding it here means it can be
 * decided in a test.
 */

/**
 * Moves one item in a list, returning a new array.
 *
 * An out-of-range move returns the list untouched rather than splicing `undefined` into it,
 * which is what "move up" on the first row would otherwise do to a student's honors section.
 */
export function moveListItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (from === to || from < 0 || to < 0 || from >= next.length || to >= next.length) return next;
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return next;
  next.splice(to, 0, moved);
  return next;
}

/**
 * A web address as the profile schema will take it, or the reason it will not.
 *
 * `links` and `projects[].url` are the only two `z.string().url()` fields on the profile,
 * and people write an address the way they read it — "github.com/rosa". Ingestion already
 * repairs a missing scheme (`asUrl` in core/ingestion/toProfile.ts) and this is the same
 * repair on the editing side, so a link typed by hand and a link read off the resume end up
 * stored the same way rather than one of them failing the save.
 *
 * The prefix-then-parse test is exactly what `z.string().url()` accepts once the scheme is
 * on, so a field this reports as fine is one the server will store, and a field it reports on
 * is one that would come back as a shape error naming no field.
 *
 * Empty is a complete answer: most people have no portfolio.
 */
export function readUrlField(raw: string | null | undefined): {
  url: string | undefined;
  problem: string | null;
} {
  const text = (raw ?? '').trim();
  if (text === '') return { url: undefined, problem: null };
  const candidate = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  if (!URL.canParse(candidate)) {
    return { url: undefined, problem: `"${text}" is not a web address` };
  }
  return { url: candidate, problem: null };
}

/**
 * Rewrites the review-flag paths for one list after its entries have moved or gone.
 *
 * Flags are positional — the extractor raises `experience.3.startDate`, `certifications.0.date`
 * — and nothing had ever moved an entry before these editors added Up, Down and Remove. So one
 * click made the gate's markers point at the wrong rows: remove entry 2 and the genuinely
 * doubtful entry renders clean while its neighbour wears an amber "check this" on a date the
 * extractor was perfectly sure of. Remove the LAST flagged entry and the flag points past the
 * end of the list, where no control can show it — leaving a flag at sign-off for a row that
 * does not exist, on a gate that blocks until its list is empty.
 *
 * `oldIndexForNew[newIndex] = oldIndex`. An old index missing from that array is an entry that
 * was removed, and its flags go with it: they described a row the user deleted.
 */
export function remapListFlags(
  needsReview: string[],
  prefix: string,
  oldIndexForNew: number[],
): string[] {
  const newIndexForOld = new Map<number, number>();
  oldIndexForNew.forEach((oldIndex, newIndex) => newIndexForOld.set(oldIndex, newIndex));

  const pattern = new RegExp(`^${prefix}\\.(\\d+)(\\..*)?$`);
  const out: string[] = [];
  for (const flag of needsReview) {
    const m = pattern.exec(flag);
    if (!m) {
      out.push(flag);
      continue;
    }
    const moved = newIndexForOld.get(Number(m[1]));
    if (moved === undefined) continue;
    out.push(`${prefix}.${String(moved)}${m[2] ?? ''}`);
  }
  return [...new Set(out)];
}

/** The identity permutation for a list of `length`, which every move and removal starts from. */
export function indexRange(length: number): number[] {
  return Array.from({ length }, (_, i) => i);
}

/**
 * The one shape the profile stores a date in, checked here rather than trusted to the input.
 *
 * Every date box in this wizard is `<input type="month">`, which in Chrome guarantees the
 * `YYYY-MM` the schema demands. Firefox and desktop Safari do not implement `type="month"`
 * at all: it degrades to a plain text box, the user types "June 2025" or "2025-6", it is
 * stored verbatim, and `YearMonth` (packages/shared/src/profile.ts) rejects the save with
 * "Profile did not match the expected shape" naming no field — on a screen that can hold
 * twenty-seven entries with two date boxes each. That is the unnamed wall this whole guard
 * exists to remove, and it was reachable in two of the three major browsers.
 *
 * Empty is a complete answer everywhere a date appears here: an absent start date is
 * ordinary, and an absent end date is how the profile spells "still there".
 */
const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function dateProblem(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim();
  if (text === '' || YEAR_MONTH.test(text)) return null;
  return `"${text}" is not a month — write it as 2027-06`;
}

/** Trims a list of free-text rows and drops the ones "Add" left empty. */
export function tidyList(xs: string[] | undefined): string[] | undefined {
  return xs === undefined ? undefined : xs.map((x) => x.trim()).filter((x) => x !== '');
}
