/**
 * Three-stage dedupe — docs/04 § Dedupe. Cheapest test first.
 *
 * Duplicates are MERGED, not dropped: the surviving posting keeps every source that saw
 * it, so the UI can say "found on Greenhouse and Adzuna" and a source going dark doesn't
 * silently lose postings.
 */
import { fingerprintTitle, normalizeCompany, normalizeTitle } from './normalize';
import type { NormalizedPosting } from './sources/types';

/**
 * The stage-2 key, built from the CAUTIOUS title form.
 *
 * Stage 2 merges on this alone, with no different-source guard, so every token the title
 * normaliser throws away costs the user a posting outright — "Machine Learning Intern I"
 * and "Machine Learning Intern II" collapsed onto one row, and one of two real openings
 * simply never appeared in the queue. `normalizeTitle` is deliberately aggressive because
 * stage 3 wants it that way, and stage 3 can afford it: it merges only across different
 * sources. This key cannot, so it uses `fingerprintTitle`, which keeps anything that could
 * distinguish two requisitions.
 *
 * Erring this way costs almost nothing. The worst case is a duplicate the user can see and
 * ignore; the other direction hides a job they will never know existed.
 */
export function fingerprint(p: {
  company: string;
  title: string;
  locations: Array<{ city?: string }>;
}): string {
  const loc = p.locations[0]?.city?.toLowerCase().trim() ?? '';
  return [normalizeCompany(p.company), fingerprintTitle(p.title), loc].join('|');
}

export interface Deduped {
  posting: NormalizedPosting;
  sources: string[];
  /** Which stage caught each merge, for the run summary. */
  mergedBy: Array<'url' | 'fingerprint' | 'title'>;
}

/**
 * Stage-3 title matching.
 *
 * This began as character-trigram Jaccard similarity, which does not work here.
 * Measured against real pairs:
 *
 *   0.767  "Software Engineer Intern"  vs  "Software Engineering Intern"        ← same job
 *   0.758  "Software Engineer Intern"  vs  "Software Engineer Intern, Backend"  ← DIFFERENT job
 *   0.613  "Software Engineer Intern"  vs  "Hardware Engineer Intern"           ← DIFFERENT job
 *   0.600  "Frontend Engineer Intern"  vs  "Backend Engineer Intern"            ← DIFFERENT job
 *
 * The pair that must merge and the pair that must not sit 0.009 apart, so no threshold
 * separates them. Character overlap is the wrong signal: what distinguishes these titles
 * is whether one carries a *discriminating token* (backend, hardware, design) the other
 * lacks — not how many characters they share.
 *
 * So: merge only when the stemmed, stopword-stripped token SETS are equal. That catches
 * engineer/engineering and refuses every pair above that shouldn't merge. It errs toward
 * not merging, which is the safe direction — a visible duplicate is a minor annoyance,
 * a silently hidden posting is the worst failure mode this tool has.
 */
const TITLE_STOPWORDS = new Set(['the', 'a', 'an', 'of', 'for', 'and', 'to', 'in', 'at']);

/** Deliberately crude — enough for engineer/engineering, not a linguistic stemmer. */
function stem(token: string): string {
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

export function titleTokens(title: string): Set<string> {
  return new Set(
    normalizeTitle(title)
      .split(' ')
      .filter((t) => t && !TITLE_STOPWORDS.has(t))
      .map(stem),
  );
}

export function titlesMatch(a: string, b: string): boolean {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  if (ta.size !== tb.size) return false;
  for (const t of ta) if (!tb.has(t)) return false;
  return true;
}

export function dedupe(incoming: Array<{ posting: NormalizedPosting; source: string }>): {
  unique: Deduped[];
  duplicates: number;
  notes: string[];
} {
  const byUrl = new Map<string, Deduped>();
  const byFingerprint = new Map<string, Deduped>();
  const notes: string[] = [];
  let duplicates = 0;

  for (const { posting, source } of incoming) {
    // Stage 1 — canonical URL.
    const existingByUrl = byUrl.get(posting.canonicalUrl);
    if (existingByUrl) {
      merge(existingByUrl, source, 'url');
      duplicates++;
      continue;
    }

    // Stage 2 — company + normalized title + primary location.
    const fp = fingerprint(posting);
    const existingByFp = byFingerprint.get(fp);
    if (existingByFp) {
      merge(existingByFp, source, 'fingerprint');
      duplicates++;
      continue;
    }

    // Stage 3 — same company, same role, different location or wording, and crucially
    // a DIFFERENT source. Two similar titles from one source are almost always distinct
    // requisitions, and merging them would hide one.
    let matched: Deduped | undefined;
    for (const candidate of byFingerprint.values()) {
      if (normalizeCompany(candidate.posting.company) !== normalizeCompany(posting.company)) {
        continue;
      }
      if (candidate.sources.includes(source)) continue;
      if (titlesMatch(candidate.posting.title, posting.title)) {
        matched = candidate;
        break;
      }
    }
    if (matched) {
      merge(matched, source, 'title');
      duplicates++;
      continue;
    }

    const entry: Deduped = { posting, sources: [source], mergedBy: [] };
    byUrl.set(posting.canonicalUrl, entry);
    byFingerprint.set(fp, entry);
  }

  if (duplicates > 0) notes.push(`merged ${duplicates} duplicate posting(s) across sources`);

  return { unique: [...byFingerprint.values()], duplicates, notes };
}

function merge(entry: Deduped, source: string, by: Deduped['mergedBy'][number]): void {
  if (!entry.sources.includes(source)) entry.sources.push(source);
  entry.mergedBy.push(by);
}
