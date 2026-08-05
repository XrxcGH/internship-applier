/**
 * Field classification — docs/07-form-automation.md § Classification.
 *
 * Turns "what is this input?" into a `FieldSemantic`. Two stages, cheap first:
 *
 *   1. This file. A rule table over the normalized label + name + id + autocomplete.
 *      Free, instant, unit-testable, and it handles the large majority of real fields.
 *   2. An LLM fallback for the remainder (see `classifyWithModel`), which only runs on
 *      fields stage 1 could not name.
 *
 * THE ORDER OF CHECKS IS THE DESIGN. Redlines are consulted before anything else, so a
 * field can never be classified into something fillable and then filled — a mislabeled SSN
 * box is refused before the question "is this a text field?" is even asked.
 *
 * WHY `autocomplete` WINS. When a form says `autocomplete="family-name"` it is telling us
 * what the field is, in a standard vocabulary, on purpose. That beats any guess made from
 * prose. Regexes only run when the attribute is absent or unrecognized.
 *
 * UNRECOGNIZED IS A REAL ANSWER. Anything below the confidence floor stays `unknown`, is
 * left blank, and is surfaced for the user. A wrong guess in a job application is worse
 * than a blank the user fills in themselves, so this file never reaches for a default.
 */
import type { FieldSemantic } from '@ia/shared';
import { checkRedline, normalizeField } from './redlines';

export interface FieldDescriptor {
  label?: string;
  name?: string;
  id?: string;
  autocomplete?: string;
  placeholder?: string;
  type?: string;
  /**
   * The kind of control, when the scanner knows it.
   *
   * Needed because a contenteditable rich-text editor has no `type` attribute at all, so
   * shape-based essay detection could not see one — and every ATS that ships a rich-text
   * essay box got "could not tell what this field is asking for" instead of the answer
   * the user approved for exactly that question.
   */
  control?: string;
  /** Nearby text, used only by the model fallback. */
  context?: string;
}

export interface Classification {
  semantic: FieldSemantic;
  confidence: number;
  /** Which rule decided, so a surprising fill can be traced back. */
  via: 'redline' | 'autocomplete' | 'rule' | 'model' | 'none';
}

/** Below this, a guess is not worth acting on. docs/07 sets it at 0.75. */
export const CONFIDENCE_FLOOR = 0.75;

/**
 * The HTML autocomplete vocabulary, mapped to our semantics.
 *
 * Only tokens with an unambiguous meaning for us are listed. `organization` is
 * deliberately absent: on an application form it may be the applicant's current employer
 * or the school, and guessing between them is exactly the mistake worth not making.
 */
const AUTOCOMPLETE: Record<string, FieldSemantic> = {
  'given-name': 'first_name',
  'family-name': 'last_name',
  name: 'full_name',
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
  'address-line1': 'address_line1',
  'street-address': 'address_line1',
  'address-level2': 'city',
  'address-level1': 'region',
  'postal-code': 'postal',
  country: 'country',
  'country-name': 'country',
  url: 'website',
};

interface Rule {
  semantic: FieldSemantic;
  test: RegExp;
  /** Rules matching a strong, unambiguous phrase are trusted more. */
  confidence: number;
}

/**
 * Ordered narrow to broad. The first match wins, so anything that could be a prefix of a
 * more specific rule must come after it — "name" after "first name", "school name", and
 * "company name", or it swallows all of them.
 */
const RULES: Rule[] = [
  // ── Identity ──────────────────────────────────────────────────────────────
  { semantic: 'first_name', test: /\b(first|given|fore) ?name\b|\bfname\b/i, confidence: 0.97 },
  {
    semantic: 'last_name',
    test: /\b(last|family|sur) ?name\b|\blname\b|\bsurname\b/i,
    confidence: 0.97,
  },
  {
    semantic: 'full_name',
    test: /\b(full|legal|preferred|display) ?name\b|\byour name\b|\bname of applicant\b/i,
    confidence: 0.9,
  },
  { semantic: 'email', test: /\be-?mail\b/i, confidence: 0.97 },
  {
    semantic: 'phone',
    test: /\b(phone|mobile|cell|telephone|contact number)\b/i,
    confidence: 0.94,
  },

  // ── Address. Region before city, because "state" is the more distinctive word.
  {
    semantic: 'address_line1',
    test: /\b(street|mailing|home|current) address\b|\baddress ?(line ?)?1\b|\baddr1\b/i,
    confidence: 0.9,
  },
  { semantic: 'postal', test: /\b(zip|postal)( ?code)?\b|\bpostcode\b/i, confidence: 0.95 },
  { semantic: 'region', test: /\b(state|province|region|county)\b/i, confidence: 0.85 },
  { semantic: 'city', test: /\b(city|town|locality)\b/i, confidence: 0.9 },
  { semantic: 'country', test: /\bcountry\b/i, confidence: 0.92 },

  // ── Links. Specific hosts before the generic "website".
  { semantic: 'linkedin', test: /\blinked ?in\b/i, confidence: 0.98 },
  { semantic: 'github', test: /\bgit ?hub\b|\bgitlab\b/i, confidence: 0.98 },
  {
    semantic: 'portfolio',
    test: /\bportfolio\b|\bpersonal (site|website)\b|\bbehance\b|\bdribbble\b/i,
    confidence: 0.92,
  },
  { semantic: 'website', test: /\b(website|web site|url|homepage|blog)\b/i, confidence: 0.8 },

  // ── Education. Uploads first, since "transcript" also appears in prose.
  {
    semantic: 'transcript_upload',
    test: /\btranscript\b/i,
    confidence: 0.9,
  },
  {
    semantic: 'school',
    test: /\b(school|university|college|institution|alma mater)\b/i,
    confidence: 0.9,
  },
  // graduation_date sits ABOVE degree deliberately. Matching is first-wins, and the
  // broad /\bdegree\b/ swallowed "Degree date" and "Degree completion date" — typing a
  // degree level into a date field and making this rule's own \bdegree date\b branch
  // unreachable.
  {
    semantic: 'graduation_date',
    test: /\bgraduation\b|\bgraduat(e|ing|ion)\b|\bdegree (date|completion)\b|\bcompletion date\b/i,
    confidence: 0.93,
  },
  {
    semantic: 'degree',
    test: /\bdegree\b|\bqualification\b|\b(bachelor|master|doctora|phd)\b/i,
    confidence: 0.9,
  },
  {
    semantic: 'major',
    test: /\bmajor\b|\bfield of study\b|\bcourse of study\b|\bdiscipline\b|\bconcentration\b/i,
    confidence: 0.92,
  },
  { semantic: 'gpa', test: /\bgpa\b|\bgrade point average\b/i, confidence: 0.97 },
  {
    semantic: 'enrollment_status',
    test: /\b(currently )?enrolled\b|\benrollment status\b|\bclass (standing|year)\b|\byear in school\b|\bacademic year\b/i,
    confidence: 0.9,
  },

  // ── Work eligibility. Sponsorship before the broader authorization phrasing.
  {
    semantic: 'sponsorship_needed',
    test: /\bsponsor(ship|ed)?\b|\bh-?1b\b|\brequire.{0,20}visa\b/i,
    confidence: 0.94,
  },
  {
    semantic: 'work_auth',
    test: /\b(legally )?authoriz(ed|ation) to work\b|\bwork (authorization|eligibility|permit)\b|\beligible to work\b|\bright to work\b/i,
    confidence: 0.94,
  },

  // ── Uploads ───────────────────────────────────────────────────────────────
  {
    semantic: 'resume_upload',
    test: /\b(resume|résumé|\bcv\b|curriculum vitae)\b/i,
    confidence: 0.95,
  },
  { semantic: 'cover_letter_upload', test: /\bcover letter\b/i, confidence: 0.95 },

  // ── Logistics ─────────────────────────────────────────────────────────────
  {
    semantic: 'start_date',
    test: /\b(start|available|availability|commence|join)( ?ing)? date\b|\bearliest start\b|\bwhen can you start\b/i,
    confidence: 0.92,
  },
  {
    semantic: 'end_date',
    test: /\b(end|finish|until) date\b|\bavailable until\b/i,
    confidence: 0.9,
  },
  {
    semantic: 'hours_available',
    test: /\bhours (per|a) week\b|\bweekly hours\b|\bhours available\b/i,
    confidence: 0.93,
  },
  {
    semantic: 'salary_expectation',
    test: /\b(salary|compensation|pay|rate) (expectation|requirement|range)\b|\b(desired|expected|target) (salary|compensation|pay|rate)\b/i,
    confidence: 0.92,
  },
  {
    semantic: 'referral_source',
    test: /\bhow did you hear\b|\bhow (did|do) you (find|learn)\b|\breferral source\b|\bwhere did you hear\b|\bsource\b/i,
    confidence: 0.88,
  },
];

/**
 * Free-text questions that route to the writing engine.
 *
 * Recognized by shape rather than keyword: a long-form control with an interrogative or
 * imperative label is an essay, whatever it happens to ask about. A keyword list would
 * never keep up with what companies invent.
 */
function looksLikeEssay(d: FieldDescriptor, normalized: string): boolean {
  const longForm =
    d.type === 'textarea' ||
    d.control === 'textarea' ||
    d.control === 'richtext' ||
    (d.label?.length ?? 0) > 60;
  const asks =
    /\?/.test(d.label ?? '') ||
    /\b(tell us|describe|explain|why|what|how|share|walk us through|in your own words)\b/i.test(
      normalized,
    );
  return longForm && asks;
}

/** Stage 1. No model, no network. */
export function classifyField(d: FieldDescriptor): Classification {
  // Refusal outranks recognition. Always.
  const red = checkRedline(d);
  if (red) return { semantic: 'REDLINE', confidence: 1, via: 'redline' };

  const auto = d.autocomplete?.trim().toLowerCase();
  if (auto && AUTOCOMPLETE[auto]) {
    return { semantic: AUTOCOMPLETE[auto], confidence: 0.99, via: 'autocomplete' };
  }

  // The placeholder joins the haystack here but not in the redline check: it is a weaker
  // signal, and a placeholder reading "e.g. 123-45-6789" should not be the only thing
  // standing between us and typing an SSN.
  const normalized = normalizeField({
    label: [d.label, d.placeholder].filter(Boolean).join(' '),
    name: d.name,
    id: d.id,
    autocomplete: d.autocomplete,
  });

  if (!normalized) return { semantic: 'unknown', confidence: 0, via: 'none' };

  for (const r of RULES) {
    if (r.test.test(normalized))
      return { semantic: r.semantic, confidence: r.confidence, via: 'rule' };
  }

  if (looksLikeEssay(d, normalized)) {
    return { semantic: 'essay', confidence: 0.85, via: 'rule' };
  }

  return { semantic: 'unknown', confidence: 0, via: 'none' };
}

/** Anything at or above the floor may be acted on. */
export function isActionable(c: Classification): boolean {
  return c.semantic !== 'unknown' && c.semantic !== 'REDLINE' && c.confidence >= CONFIDENCE_FLOOR;
}
