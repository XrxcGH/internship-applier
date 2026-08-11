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

/** Trims a list of free-text rows and drops the ones "Add" left empty. */
export function tidyList(xs: string[] | undefined): string[] | undefined {
  return xs === undefined ? undefined : xs.map((x) => x.trim()).filter((x) => x !== '');
}
