/**
 * Quote verification — docs/05 § Stage 0, guard 1.
 *
 * Every extracted requirement must cite text that ACTUALLY appears in the job
 * description. A hallucinated quote could wrongly disqualify the user, which is the
 * most damaging thing this system can do, so a requirement whose quote can't be found
 * is dropped rather than trusted.
 *
 * Pure and cheap — no model call — which means it is fully testable and always runs.
 */

/** U+00A0 non-breaking space — common in postings pasted out of Word. */
const NBSP = new RegExp(String.fromCharCode(0x00a0), 'g');

/**
 * Whitespace-, quote-, and dash-insensitive containment.
 *
 * The model reliably reproduces wording but not typography: it will turn a curly
 * apostrophe straight, collapse a line break inside a sentence, or normalise an
 * en dash. Those are faithful quotes and must pass. What must NOT pass is invented
 * wording, so nothing here touches letters.
 */
export function normalizeForQuoteMatch(s: string): string {
  return s
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(NBSP, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export interface QuoteCheck {
  ok: boolean;
  reason?: string;
}

const MIN_QUOTE_CHARS = 8;

export function verifyQuote(quote: string, description: string): QuoteCheck {
  const q = normalizeForQuoteMatch(quote);

  if (q.length === 0) return { ok: false, reason: 'empty quote' };
  if (q.length < MIN_QUOTE_CHARS) {
    // A two-word "quote" matches almost any document and proves nothing.
    return { ok: false, reason: `quote too short to verify (${q.length} chars)` };
  }

  return normalizeForQuoteMatch(description).includes(q)
    ? { ok: true }
    : { ok: false, reason: 'quote does not appear in the job description' };
}

export interface Quotable {
  sourceQuote: string;
  kind: string;
  confidence: number;
}

export interface GuardOutcome<T> {
  kept: T[];
  dropped: Array<{ item: T; reason: string }>;
}

/** Drops any requirement whose quote can't be found, reporting why. */
export function guardQuotes<T extends Quotable>(items: T[], description: string): GuardOutcome<T> {
  const kept: T[] = [];
  const dropped: Array<{ item: T; reason: string }> = [];

  for (const item of items) {
    const check = verifyQuote(item.sourceQuote, description);
    if (check.ok) kept.push(item);
    else dropped.push({ item, reason: check.reason ?? 'unverified' });
  }

  return { kept, dropped };
}
