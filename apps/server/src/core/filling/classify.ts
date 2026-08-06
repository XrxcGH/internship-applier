/**
 * Field classification — docs/07-form-automation.md § Classification.
 *
 * Turns "what is this input?" into a `FieldSemantic`. Two stages were specified, cheap
 * first, and only the first of them exists:
 *
 *   1. This file. A rule table over the normalized label + name + id + autocomplete.
 *      Free, instant, unit-testable, and it handles the large majority of real fields.
 *   2. Not built. docs/07 § Classification specifies an LLM fallback over the fields stage 1
 *      cannot name, returning its own semantic and confidence. Until it exists, a field
 *      stage 1 does not recognize stays `unknown` and is handed back to the user, which is
 *      the safe half of that design and the reason its absence is not urgent.
 *
 * THE ORDER OF CHECKS IS THE DESIGN. Redlines are consulted before anything else, so a
 * field can never be classified into something fillable and then filled — a mislabeled SSN
 * box is refused before the question "is this a text field?" is even asked.
 *
 * WHY `autocomplete` WINS. When a form says `autocomplete="family-name"` it is telling us
 * what the field is, in a standard vocabulary, on purpose. That beats any guess made from
 * prose. Regexes only run when the attribute is absent or unrecognized — or, in the single
 * case spelled out at NOT_A_MAILING_ADDRESS, when the label is asking about someone's
 * origins and the token can only describe where they get their post.
 *
 * UNRECOGNIZED IS A REAL ANSWER. Anything below the confidence floor is treated as
 * `unknown` by the planner, left blank, and surfaced for the user. A wrong guess in a job
 * application is worse than a blank the user fills in themselves, so this file never
 * reaches for a default.
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
}

export interface Classification {
  semantic: FieldSemantic;
  confidence: number;
  /** Which rule decided, so a surprising fill can be traced back. */
  via: 'redline' | 'autocomplete' | 'rule' | 'none';
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
  /** When this matches too, the rule does not apply and matching carries on. */
  unless?: RegExp;
}

/**
 * Qualifiers that mean an address word is not asking where the user lives.
 *
 * "City of birth", "Country of birth" and "Country of citizenship" all contain the word the
 * city and country rules look for, and the address on the profile answers none of them. A
 * student who moved to Columbus for school had Columbus entered as the city they were born
 * in, and a permanent resident whose only citizenship is Indian had "US" — read straight off
 * their home address — typed into a citizenship box at 0.92 confidence. That is a false
 * statement about someone's immigration status on an employer's form, and it came back to
 * them in the review as a field filled successfully, with no reason to look at it twice.
 *
 * These fall through to `unknown` rather than to a redline, and the difference is not
 * cosmetic. A redline is a refusal to fill something the tool could fill; this is the tool
 * not having the answer. There is no birthplace anywhere in the profile, so `unknown` is the
 * honest result — the planner leaves the box empty and shows it to the user, which is the
 * treatment a box labelled "Place of birth" already got, purely because no rule happened to
 * match those words. If a birthplace is ever collected, it belongs on the redline list beside
 * the other origin questions rather than in this table. Citizenship is the one that could be
 * answered honestly one day, because the profile does carry `citizenships` — but it would
 * have to come from that field, and only when it names exactly one country. Never from an
 * address.
 */
const NOT_A_MAILING_ADDRESS =
  /\bbirth\b|\bborn\b|\bcitizen(ship)?s?\b|\bnationalit(y|ies)\b|\bnational origin\b/i;

/**
 * Wording that turns a school word into context rather than the question.
 *
 * "University graduation date" asks when, not where; "Year in school" asks how far along.
 * Neither is answered by the name of the institution. See the `unless` on the school rule
 * for what went wrong while these were missing.
 */
const ASKS_WHEN_NOT_WHICH =
  /\bgraduat\w*\b.{0,20}\b(dates?|years?|months?|terms?|semesters?)\b|\b(date|year|month|when)\b.{0,20}\bgraduat|\byear\b.{0,20}\bin school\b|\bclass (standing|year)\b|\bacademic year\b/i;

/** The semantics whose value is read off the profile's address, whatever named them. */
const FROM_MAILING_ADDRESS = new Set<FieldSemantic>([
  'address_line1',
  'city',
  'region',
  'postal',
  'country',
]);

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
  //    Every rule here answers from the profile's mailing address, so every one of them
  //    carries the same disqualifier: see NOT_A_MAILING_ADDRESS above.
  {
    semantic: 'address_line1',
    test: /\b(street|mailing|home|current) address\b|\baddress ?(line ?)?1\b|\baddr1\b/i,
    confidence: 0.9,
    unless: NOT_A_MAILING_ADDRESS,
  },
  {
    semantic: 'postal',
    test: /\b(zip|postal)( ?code)?\b|\bpostcode\b/i,
    confidence: 0.95,
    unless: NOT_A_MAILING_ADDRESS,
  },
  {
    semantic: 'region',
    test: /\b(state|province|region|county)\b/i,
    confidence: 0.85,
    unless: NOT_A_MAILING_ADDRESS,
  },
  {
    semantic: 'city',
    test: /\b(city|town|locality)\b/i,
    confidence: 0.9,
    unless: NOT_A_MAILING_ADDRESS,
  },
  { semantic: 'country', test: /\bcountry\b/i, confidence: 0.92, unless: NOT_A_MAILING_ADDRESS },

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
    // A school word names a school only when the question asks WHICH one. This rule sits
    // above graduation_date and enrollment_status, and matching is first-wins, so
    // "University graduation date", "College graduation year" and "When did you graduate
    // from college?" were all answered with the institution — the school's name typed into
    // a date box, read back unchanged, and reported to the user as filled successfully.
    // The same shadowing hid "Year in school", which is a class-standing question and had
    // its own branch in enrollment_status that nothing could ever reach.
    //
    // The disqualifier needs the graduation word paired with a date, a year or a "when".
    // The bare adjective must not disqualify anything, or "Graduate school" — which is
    // asking which one — would fall through to a date rule. ("Graduate program" never
    // reaches this rule: it carries no school word, so an earlier rule claims it first.)
    unless: ASKS_WHEN_NOT_WHICH,
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
    test: /\b(currently )?enrolled\b|\benrollment status\b|\bclass (standing|year)\b|\byear\b.{0,20}\bin school\b|\bacademic year\b/i,
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
 * Recognized by shape rather than keyword: a long-form control whose label asks something is
 * an essay, whatever it happens to ask about. A keyword list would never keep up with what
 * companies invent.
 *
 * THE SHAPE TEST RUNS BEFORE THE RULE TABLE, and that ordering is the whole point. When the
 * rules went first, any essay prompt that merely MENTIONED a word in the table was answered
 * with the value behind that word: "Describe a leadership role you have held in college."
 * had the string "Cornell University" typed into a 600-character box, "Why did you choose
 * your major?" got "Computer Science", and "Share a link to something you have built
 * (GitHub, portfolio, etc.) and describe it." got a bare profile URL. The answer the user had
 * written and approved for that exact question was dropped without a word, and the field came
 * back in the review as successfully filled — so the wrong answer was also the one nobody was
 * asked to look at.
 *
 * A label that NAMES a field is still a field, which is why the test needs the question and
 * not just the big box. "Cover letter" over a textarea asks nothing, so it stays
 * cover_letter_upload and a pasted letter still lands there.
 */
function isLongFormControl(d: FieldDescriptor): boolean {
  return d.type === 'textarea' || d.control === 'textarea' || d.control === 'richtext';
}

function asksSomething(d: FieldDescriptor, normalized: string): boolean {
  return (
    /\?/.test(d.label ?? '') ||
    /\b(tell us|describe|explain|why|what|how|share|walk us through|in your own words)\b/i.test(
      normalized,
    )
  );
}

/** Stage 1. No model, no network. */
export function classifyField(d: FieldDescriptor): Classification {
  // Refusal outranks recognition. Always.
  const red = checkRedline(d);
  if (red) return { semantic: 'REDLINE', confidence: 1, via: 'redline' };

  // The placeholder joins the haystack here but not in the redline check: it is a weaker
  // signal, and a placeholder reading "e.g. 123-45-6789" should not be the only thing
  // standing between us and typing an SSN.
  const normalized = normalizeField({
    label: [d.label, d.placeholder].filter(Boolean).join(' '),
    name: d.name,
    id: d.id,
    autocomplete: d.autocomplete,
  });

  const auto = d.autocomplete?.trim().toLowerCase();
  const declared = auto ? AUTOCOMPLETE[auto] : undefined;
  // The one place a declared token is not the last word. `autocomplete="country"` is the
  // browser's vocabulary for the country of a postal address, so a form that puts it on a
  // "Country of birth" box has answered a different question than the one on screen — and
  // trusting it would type the user's home country into their birthplace by the same route
  // the label rules used to.
  if (declared && !(FROM_MAILING_ADDRESS.has(declared) && NOT_A_MAILING_ADDRESS.test(normalized))) {
    return { semantic: declared, confidence: 0.99, via: 'autocomplete' };
  }

  if (!normalized) return { semantic: 'unknown', confidence: 0, via: 'none' };

  if (isLongFormControl(d) && asksSomething(d, normalized)) {
    return { semantic: 'essay', confidence: 0.85, via: 'rule' };
  }

  for (const r of RULES) {
    if (r.test.test(normalized) && !r.unless?.test(normalized))
      return { semantic: r.semantic, confidence: r.confidence, via: 'rule' };
  }

  // A label longer than a line is the weakest of the essay signals, and it stays BELOW the
  // rule table on purpose. Plenty of dropdowns and radio groups ask a wordy question — "Will
  // you now or in the future require sponsorship for employment visa status?" is seventy
  // characters of yes/no — and if length alone outranked the rules, the profile's answer to
  // exactly that question would be replaced by a demand for an essay the user never wrote.
  if ((d.label?.length ?? 0) > 60 && asksSomething(d, normalized)) {
    return { semantic: 'essay', confidence: 0.85, via: 'rule' };
  }

  return { semantic: 'unknown', confidence: 0, via: 'none' };
}

/**
 * Anything at or above the floor may be acted on.
 *
 * Takes the semantic and the confidence rather than a whole `Classification`, because the
 * planner asks this question of a `FormField` that has already been through the scanner and
 * no longer carries which rule decided it. The floor has to be enforced there — the plan is
 * the last thing between a guess and a keystroke.
 */
export function isActionable(c: { semantic: FieldSemantic; confidence: number }): boolean {
  return c.semantic !== 'unknown' && c.semantic !== 'REDLINE' && c.confidence >= CONFIDENCE_FLOOR;
}
