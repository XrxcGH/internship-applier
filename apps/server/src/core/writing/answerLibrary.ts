/**
 * Answer library — docs/06 § ⑥.
 *
 * "Why do you want to work here?" gets asked by every company on the list. Drafting it
 * forty times costs forty model calls and produces forty slightly different answers, one
 * of which is the worst. Drafting it once, approving it once, and reusing it is both
 * cheaper and better.
 *
 * THE RULE THAT MATTERS: an answer that names the company is never reused for a different
 * company. The failure mode here is the one that ends an application immediately — a
 * cover letter addressed to the wrong employer — and no amount of convenience is worth
 * risking it. Question archetypes carry a `companySpecific` flag, and reuse across
 * companies is refused for those regardless of how similar the question text is.
 *
 * Reuse pre-fills; it does not approve. Gate G3 still applies to every answer on every
 * application. What reuse buys is a fast confirm instead of a fresh review, and the card
 * says where the text came from.
 */
import { desc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { db, schema } from '../../infra/db/client';

export type Archetype =
  | 'why_company'
  | 'why_role'
  | 'proud_of'
  | 'challenge'
  | 'teamwork'
  | 'failure'
  | 'learning'
  | 'leadership'
  | 'technical_interest'
  | 'availability'
  | 'relocation'
  | 'how_heard'
  | 'anything_else'
  | 'other';

interface ArchetypeRule {
  archetype: Archetype;
  /** True when a good answer names the company, so it cannot be reused elsewhere. */
  companySpecific: boolean;
  pattern: RegExp;
}

/**
 * Order matters: the first match wins, so the narrower patterns come first.
 * "Why do you want to work at Acme" is why_company, not why_role, even though both
 * contain "why do you want".
 */
const RULES: ArchetypeRule[] = [
  {
    archetype: 'why_company',
    companySpecific: true,
    pattern:
      /\b(why (?:do you want to|would you like to|are you interested in) (?:work|intern|join)|why (?:us|our (?:company|team|firm))|what (?:draws|drew|attracts?) you to (?:us|our)|interest in (?:our|this) company)\b/i,
  },
  {
    archetype: 'why_role',
    companySpecific: false,
    pattern:
      /\b(why (?:are you |this )?(?:interested in |applying (?:for|to) )?this (?:role|position|internship|opportunity)|what (?:interests|excites) you about this (?:role|position))\b/i,
  },
  {
    archetype: 'proud_of',
    companySpecific: false,
    pattern:
      /\b(proud(?:est)? of|something you (?:built|made|created|shipped)|favou?rite project|best (?:work|project)|tell (?:us|me) about a project)\b/i,
  },
  {
    archetype: 'challenge',
    companySpecific: false,
    pattern:
      /\b(challeng(?:e|ing)|difficult (?:problem|situation|bug)|obstacle|overc(?:ame|ome)|hardest)\b/i,
  },
  {
    archetype: 'failure',
    companySpecific: false,
    pattern: /\b(fail(?:ed|ure)|mistake|went wrong|did ?n[o']t (?:go|work) (?:well|out))\b/i,
  },
  {
    archetype: 'teamwork',
    companySpecific: false,
    pattern: /\b(team|collaborat|group (?:project|setting)|disagree(?:ment)? with a)\b/i,
  },
  {
    archetype: 'leadership',
    companySpecific: false,
    pattern: /\b(lead(?:ership)?|led a|took (?:the )?initiative|mentor)\b/i,
  },
  {
    archetype: 'learning',
    companySpecific: false,
    pattern:
      /\b(learn(?:ed|ing)? (?:something|a new)|taught yourself|picked up (?:a|new)|self.?taught)\b/i,
  },
  {
    archetype: 'technical_interest',
    companySpecific: false,
    pattern:
      /\b(what (?:area|part|kind) of (?:engineering|software|technology)|technical interests?|what do you (?:like|enjoy) (?:building|working on))\b/i,
  },
  {
    archetype: 'availability',
    companySpecific: false,
    pattern: /\b(available|availability|start date|when (?:can|could) you (?:start|begin))\b/i,
  },
  {
    archetype: 'relocation',
    companySpecific: false,
    pattern: /\b(relocat|willing to move|able to (?:work|be) (?:in|on.?site))\b/i,
  },
  {
    archetype: 'how_heard',
    companySpecific: true,
    pattern: /\b(how did you (?:hear|find out|learn) about|where did you (?:hear|find))\b/i,
  },
  {
    archetype: 'anything_else',
    companySpecific: false,
    pattern: /\b(anything else|additional information|is there anything|other information)\b/i,
  },
];

export interface Classified {
  archetype: Archetype;
  companySpecific: boolean;
  /** Stable lookup key. Archetype for recognised questions, a text hash otherwise. */
  key: string;
}

/** Strip a question to comparable words, so trivial rewordings share a key. */
function canonical(question: string): string {
  return question
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(?:max|maximum|no more than|up to|within|limit)\b.*$/i, ' ')
    .replace(/\b\d+\s*(?:words?|characters?)\b/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(
      /\b(?:please|kindly|briefly|the|a|an|your|you|us|we|our|is|are|do|does|to|of|in|for|and|or|that|this)\b/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Small stable hash. Not security-relevant — this is a bucket label. */
function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function classifyQuestion(question: string): Classified {
  for (const rule of RULES) {
    if (rule.pattern.test(question)) {
      return {
        archetype: rule.archetype,
        companySpecific: rule.companySpecific,
        key: rule.archetype,
      };
    }
  }
  // Unrecognised questions still get reuse, but only for a near-identical restatement.
  return { archetype: 'other', companySpecific: false, key: `q:${hash(canonical(question))}` };
}

// ─────────────────────────────────────────────────────────────── edit distance

/**
 * Levenshtein over words, not characters. The G3 meter is answering "how much of this did
 * you rewrite", and a user who replaces one word in a sentence has not rewritten the
 * sentence — character distance would say otherwise.
 */
export function wordEditDistance(a: string, b: string): number {
  const x = a.toLowerCase().match(/\S+/g) ?? [];
  const y = b.toLowerCase().match(/\S+/g) ?? [];
  if (x.length === 0) return y.length;
  if (y.length === 0) return x.length;

  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[y.length]!;
}

/** 0 = untouched, 1 = rewritten from scratch. */
export function editFraction(draft: string, final: string): number {
  const longest = Math.max((draft.match(/\S+/g) ?? []).length, (final.match(/\S+/g) ?? []).length);
  if (longest === 0) return 0;
  return Math.min(1, wordEditDistance(draft, final) / longest);
}

/**
 * What the meter says out loud. Heavy editing is not a failure — it is the signal that
 * the voice model needs the edited version as a sample.
 */
export function describeEditing(fraction: number): string {
  if (fraction === 0) return 'You approved this unchanged.';
  if (fraction < 0.15) return 'You changed a few words.';
  if (fraction < 0.4) return 'You reworked about a third of this.';
  if (fraction < 0.75) return 'You rewrote most of this.';
  return 'You rewrote this almost entirely. Worth saving as a writing sample.';
}

// ─────────────────────────────────────────────────────────────── persistence

export interface LibraryEntry {
  id: string;
  key: string;
  text: string;
  useCount: number;
  lastUsedAt: string | null;
  approvedAt: string | null;
  /** The company this text was written for, when it names one. */
  company: string | null;
}

interface StoredVariants {
  company?: string | null;
}

function toEntry(row: typeof schema.answerTemplate.$inferSelect): LibraryEntry {
  const variants = (row.variants ?? {}) as StoredVariants;
  return {
    id: row.id,
    key: row.questionKey,
    text: row.canonicalText,
    useCount: row.useCount,
    lastUsedAt: row.lastUsedAt,
    approvedAt: row.approvedAt,
    company: variants.company ?? null,
  };
}

/**
 * An approved answer to reuse, or null.
 *
 * Refuses to cross companies for company-specific archetypes — see the header. Also
 * refuses anything never approved: an unapproved draft is not a library entry.
 */
export function findReusable(question: string, company: string | null): LibraryEntry | null {
  const { key, companySpecific } = classifyQuestion(question);

  const row = db
    .select()
    .from(schema.answerTemplate)
    .where(eq(schema.answerTemplate.questionKey, key))
    .orderBy(desc(schema.answerTemplate.lastUsedAt))
    .all()[0];

  if (!row?.approvedAt) return null;
  const entry = toEntry(row);

  if (companySpecific) {
    const sameCompany =
      entry.company !== null &&
      company !== null &&
      entry.company.toLowerCase() === company.toLowerCase();
    if (!sameCompany) return null;
  }
  return entry;
}

/** Records an approved answer so the next application can reuse it. */
export function saveApproved(question: string, text: string, company: string | null): void {
  const { key } = classifyQuestion(question);
  const now = new Date().toISOString();

  const existing = db
    .select()
    .from(schema.answerTemplate)
    .where(eq(schema.answerTemplate.questionKey, key))
    .all()[0];

  if (existing) {
    db.update(schema.answerTemplate)
      .set({
        canonicalText: text,
        variants: { company },
        useCount: existing.useCount + 1,
        lastUsedAt: now,
        approvedAt: now,
      })
      .where(eq(schema.answerTemplate.id, existing.id))
      .run();
    return;
  }

  db.insert(schema.answerTemplate)
    .values({
      id: ulid(),
      questionKey: key,
      canonicalText: text,
      variants: { company },
      useCount: 1,
      lastUsedAt: now,
      approvedAt: now,
    })
    .run();
}

export function listLibrary(): LibraryEntry[] {
  return db
    .select()
    .from(schema.answerTemplate)
    .orderBy(desc(schema.answerTemplate.lastUsedAt))
    .all()
    .map(toEntry);
}
