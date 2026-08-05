/**
 * Redlines — fields this tool never fills. docs/07-form-automation.md § Redlines.
 *
 * This is the most safety-critical file in the form-filling path, and the reasoning is
 * worth stating rather than assuming.
 *
 * WHY A KEYWORD BLOCKLIST AND NOT JUST SEMANTIC CLASSIFICATION. Classification asks "what
 * is this field?" and answers with a best guess. A blocklist asks "does this look like
 * something I must not touch?" and errs toward yes. The two run independently and a match
 * from EITHER is enough, because the failure modes are asymmetric: wrongly skipping an
 * ordinary field costs the user thirty seconds of typing, while wrongly filling an
 * attestation checkbox means a machine signed a legal statement in someone's name.
 *
 * WHY IT IS NOT CONFIGURABLE. A setting that turns these off would, the first time it was
 * used, be the setting that caused the harm. There is no override parameter anywhere in
 * the call chain.
 *
 * FOUR THINGS ARE PROTECTED HERE, AND THEY ARE DIFFERENT KINDS OF THING:
 *   - Identity and financial numbers, because the tool should not hold or transcribe them.
 *   - Credentials, same.
 *   - Attestations and consent, because those are a person's own statement to make.
 *   - Demographic self-identification, because it is voluntary, it is not the tool's to
 *     answer, and a guess would be both wrong and offensive.
 *
 * AI disclosure is separate again: it is not skipped quietly. It is skipped and raised,
 * because it is the one question where the user needs to make a deliberate choice.
 */
import type { RedlineCategory } from '@ia/shared';

export interface RedlinePattern {
  category: RedlineCategory;
  test: RegExp;
  /** Shown to the user in the skipped-fields list. */
  note: string;
}

/**
 * Fields that LOOK like redlines but are legitimately fillable, checked first.
 *
 * Without this, "Are you legally authorized to work in the United States?" gets caught by
 * a citizenship pattern and the user has to answer their own eligibility question by hand
 * on every application. Work authorization is on the profile, it drives the matching
 * rules, and answering it is the entire point of the tool.
 */
const ALLOWLIST: RegExp[] = [
  /\b(legally )?authoriz(ed|ation) to work\b/i,
  /\b(require|need)( ?s)? sponsorship\b/i,
  /\bwill you (now or in the future )?require\b/i,
  /\bwork (authorization|eligibility|permit|visa) status\b/i,
  /\bare you eligible to work\b/i,
  // Graduation and start dates read like "date" patterns but are ordinary facts.
  /\b(expected |anticipated )?graduation date\b/i,
  /\b(earliest |available )?start date\b/i,
  // What you are ASKING for is answerable from the profile. What you were PAID is
  // history, which is a different question and restricted in several states. This
  // allowlist entry is what keeps the history pattern below free to be broad.
  /\b(salary|compensation|pay|wage)\s*(expectation|requirement|range|desired|expected)\b/i,
  /\b(desired|expected|target|requested)\s+(salary|compensation|pay|rate)\b/i,
  // A username qualified by a public platform is a profile link, not a credential. The
  // credential pattern has to catch a bare "Username" on a sign-up form, so the
  // distinction has to be made here.
  /\b(github|gitlab|linkedin|twitter|x|behance|dribbble|portfolio|stack ?overflow|kaggle|leetcode)\b.{0,12}\b(username|handle|profile|url|id)\b/i,
];

/** True when a label is explicitly fine to fill despite resembling a redline. */
export function isAllowlisted(normalized: string): boolean {
  return ALLOWLIST.some((r) => r.test(normalized));
}

export const REDLINE_PATTERNS: RedlinePattern[] = [
  // ── Government and identity numbers ────────────────────────────────────────
  {
    category: 'government_id',
    test: /\b(social security( number| no\.?| #)?|ssn|sin\b|national insurance|nino\b|national id(entity)? (number|card)|tax(payer)? (id|identification)|\btin\b|\bitin\b)\b/i,
    note: 'A government identification number. Type this yourself if the form requires it.',
  },
  {
    category: 'government_id',
    test: /\b(passport|visa) (number|no\.?|#)\b|\bdriver'?s? licen[cs]e( number| no\.?| #)?\b|\bstate id (number|card)\b|\balien (registration )?number\b|\buscis\b|\bi-?94\b|\bi-?20\b/i,
    note: 'An identity document number. Type this yourself if the form requires it.',
  },
  {
    category: 'government_id',
    test: /\bdate of birth\b|\bbirth ?date\b|\b\bdob\b/i,
    note: 'Date of birth. Held locally for eligibility filtering only, and never entered into a form.',
  },
  {
    // Abbreviations and punctuation-stripped forms. `normalizeField` flattens separators,
    // so "ss#" arrives as "ss" and "Soc Sec No." as "soc sec no".
    category: 'government_id',
    test: /\bss#|\bss num\b|\bsoc sec\b|\bssn?\b|\bni number\b|\bni no\b|\bdl (number|num|no)\b|\blicen[cs]e (number|num|no)\b/i,
    note: 'A government identification number. Type this yourself if the form requires it.',
  },
  {
    // Non-US national identifiers. Without these the tool is only safe for US applicants,
    // which is not a defensible place to stop.
    category: 'government_id',
    test: /\baadhaar\b|\bpan card\b|\bnric\b|\bfin number\b|\bmykad\b|\bcnic\b|\bpersonnummer\b|\bcurp\b|\bhkid\b|\bcodice fiscale\b|\bemirates id\b|\bdni\b|\bnie\b|\bbsn\b|\brut\b|\bc[eé]dula\b|\bcpf\b|\bcnpj\b|\bnif\b|\bsteuernummer\b|\btax file number\b|\btfn\b|\butr\b|\bein\b|\bnumero de\b|\bnum[eé]ro de\b/i,
    note: 'A national identification number. Type this yourself if the form requires it.',
  },
  {
    category: 'government_id',
    test: /\bgovernment.?issued\b|\bgovt id\b|\bstate.?issued\b|\bidentification document\b|\bproof of identity\b|\bid (number|card|document)\b|\b(work|residence) permit\b|\bbrp\b/i,
    note: 'An identity document. Type this yourself if the form requires it.',
  },
  {
    // A passport's expiry and country of issue are as sensitive as its number.
    category: 'government_id',
    test: /\bpassport\b/i,
    note: 'Passport details. Type these yourself if the form requires them.',
  },

  // ── Financial ──────────────────────────────────────────────────────────────
  {
    category: 'financial',
    test: /\b(bank|checking|chequing|savings|deposit) (account|details|form)\b|\bacct\b|\baccount (number|holder|no)\b|\brouting (number|no\.?)\b|\biban\b|\bswift\b|\bsort code\b|\bbsb\b|\bifsc\b|\btransit number\b|\binstitution number\b|\bbranch code\b|\bmicr\b|\bbic\b|\bwire transfer\b|\bvoided che(que|ck)\b|\bdirect deposit\b/i,
    note: 'Bank details. This tool never handles payment information.',
  },
  {
    // `cc-number`, `cc-csc`, `cc-exp` are HTML autocomplete tokens, and a form can declare
    // them without any label at all.
    category: 'financial',
    test: /\b(credit|debit) card\b|\bcard (number|holder|security|verification|expir)\b|\bcvv\b|\bcvc\b|\bcsc\b|\bcc (number|name|type|csc|exp)\b|\bbilling (address|zip|postal)\b|\bpaypal\b|\bvenmo\b|\bzelle\b/i,
    note: 'Payment details. This tool never handles payment information.',
  },
  {
    category: 'financial',
    // Matches in either order, because forms phrase this both as "Current salary" and as
    // "What was your salary at your last position?". Safe to be broad here only because
    // the allowlist has already claimed expectation and desired-compensation phrasings.
    test: /\bsalary history\b|\b(current|previous|prior|last|most recent|former)\s+(salary|compensation|pay|wage)\b|\b(salary|compensation|pay|wage|earn(ed|ings)?|paid)\b.{0,40}\b(last|previous|prior|current|most recent|former|history)\b/i,
    note: 'Salary history. Asking this is restricted in several US states, and it is yours to answer or decline.',
  },

  // ── Credentials ────────────────────────────────────────────────────────────
  {
    category: 'credential',
    // Security-question ANSWERS are the part worth naming explicitly. They are phrased as
    // harmless trivia — a first pet, a mother's maiden name, the street you grew up on —
    // and nothing about the wording says "credential", but they unlock account recovery.
    test: /\bpass(word|phrase|code)\b|\bpwd\b|\b(security|secret|recovery) (question|answer|word|code)\b|\bmemorable word\b|\bpin\b(?! ?code for)|\bpersonal identification number\b|\b(verification|confirmation|authentication|authenticator|sms|digit)\b\s*(\w+\s+)?code\b|\bone[- ]time (code|password)\b|\botp\b|\b2fa\b|\busername\b|\buser id\b|\blogin id\b|\bscreen name\b|\baccount name\b|\bmaiden name\b|\bfirst pet\b|\bchildhood\b|\bgrew up on\b|\bfirst teacher\b|\bfavou?rite teacher\b/i,
    note: 'A credential. This tool never types into password or security fields.',
  },

  // ── Attestations: the user's own legal statement ───────────────────────────
  {
    category: 'attestation',
    // Forms phrase these in the first AND third person ("The applicant certifies"), and
    // several jurisdictions use their own noun for it.
    test: /\b(i|applicant|candidate|undersigned)\b.{0,24}\b(certif|attest|affirm|declare|acknowledge|swear)/i,
    note: 'A statement you are making personally. Only you can make it.',
  },
  {
    category: 'attestation',
    // `certification` and `declaration` on their own are far too broad: a professional
    // certification is a resume item and "declaration of major" is an academic term. Both
    // need a second word that makes the legal sense unambiguous.
    test: /\bunder (penalty of perjury|oath)\b|\btrue and (complete|correct|accurate)\b|\bto the best of my knowledge\b|\battestation\b|\b(applicant|candidate|employee) (certification|declaration)\b|\b(certification|declaration) (statement|and authorization|of truth)\b|\baffidavit\b|\bstatement of truth\b|\bsworn\b|\bnotari[sz]/i,
    note: 'A sworn or certified statement. Only you can make it.',
  },
  {
    category: 'attestation',
    test: /\b(e ?)?signature\b|\bsignatory\b|\bdocusign\b|\bsign (here|below|and date|this)\b|\bplease sign\b|\bsigned (by|date)\b|\bdate of signing\b|\btype your (full )?name to sign\b|\binitials?\b|\bdate signed\b/i,
    note: 'A signature. This tool does not sign anything on your behalf.',
  },

  // ── Consent: the user's to give ────────────────────────────────────────────
  {
    category: 'consent',
    test: /\bi (agree|consent|authorize)\b|\bterms (of (service|use)|and conditions)\b|\bprivacy policy\b|\baccept the terms\b|\barbitration\b/i,
    note: 'Consent is yours to give. Read it and decide.',
  },
  {
    category: 'consent',
    test: /\bbackground (check|screening|investigation)\b|\bcredit check\b|\bdrug (test|screen)\b|\bconsumer report\b|\bfcra\b|\bcontact\b.{0,24}\b(employer|supervisor|manager|references?)\b/i,
    note: 'An authorization to investigate you. Yours to give.',
  },
  {
    category: 'consent',
    // `\bmarketing\b` on its own is deliberately absent: "Major: Marketing" is a real
    // field on a student application and refusing to fill it would be absurd. The opt-in
    // sense has to be established by a second word, or by opt-in vocabulary directly.
    test: /\b(marketing|promotional)\s+(email|communication|material|message|opt)|\bsubscribe\b|\bopt[-\s]?in\b|\boptin\b|\bnewsletter\b|\bsend me\b|\bshare (my )?(data|information) with\b/i,
    note: 'A communications or data-sharing opt-in. Left for you to choose.',
  },

  // ── EEO and voluntary self-identification ──────────────────────────────────
  {
    category: 'eeo_demographic',
    test: /\brace\b|\bethnicit|\bhispanic\b|\blatino\b|\bgender\b|\bsex\b(?!ual harassment)|\bpronouns?\b|\bsexual orientation\b|\blgbt/i,
    note: 'Voluntary self-identification. Not this tool’s to answer.',
  },
  {
    category: 'eeo_demographic',
    test: /\b(protected )?veteran\b|\bmilitary (service|status)\b|\bdisability (status)?\b|\bcc-?305\b|\bself[- ]identif/i,
    note: 'Voluntary self-identification. Not this tool’s to answer.',
  },
  {
    category: 'eeo_demographic',
    test: /\breligio|\bpolitical (affiliation|party)\b|\bunion member|\bmarital status\b|\bnumber of (children|dependents)\b|\bhealth (condition|information)\b|\bmedical\b/i,
    note: 'Personal information the tool will not guess at.',
  },
  {
    category: 'eeo_demographic',
    test: /\b(criminal|conviction|convicted|felony|misdemeanor|arrest)\b/i,
    note: 'Criminal history. Yours to answer, and the rules around it vary by jurisdiction.',
  },
  {
    category: 'eeo_demographic',
    test: /\bemergency contact\b|\bnext of kin\b|\bin case of emergency\b/i,
    note: 'Someone else’s personal details. Not stored here, so not filled.',
  },

  // ── AI disclosure: skipped AND raised ──────────────────────────────────────
  {
    category: 'ai_disclosure',
    test: /\b(ai|a\.i\.|artificial intelligence|chatgpt|llm|language model|generative)\b.{0,40}\b(use|used|assist|generat|write|wrote|help)|\b(use|used)\b.{0,20}\b(ai|artificial intelligence|chatgpt)\b/i,
    note: 'This asks whether AI helped with your application. Answer it yourself, honestly. This tool will not answer it for you.',
  },
];

export interface RedlineMatch {
  category: RedlineCategory;
  note: string;
  /** The pattern source, so a surprising skip can be traced. */
  matched: string;
}

/**
 * Normalizes the strings that describe a field into one haystack.
 *
 * Label, name, id, and autocomplete are all checked together because forms hide the
 * meaning in different places: a Greenhouse field may have a meaningless `name="q_9812"`
 * and a real label, while another has no label and `name="ssn"`.
 */
export function normalizeField(parts: {
  label?: string;
  name?: string;
  id?: string;
  autocomplete?: string;
}): string {
  return (
    [parts.label, parts.name, parts.id, parts.autocomplete]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      // Diacritics are folded away, because "é" is not a word character and every \b in
      // every pattern here fails around it. A field labelled "Résumé" matched nothing at
      // all and was handed back to the user to attach by hand.
      .normalize('NFD')
      .replace(/\p{M}+/gu, '')
      .replace(/[_\-.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * The decision. Returns a match when the field must not be filled.
 *
 * The allowlist is consulted first and wins, because those phrases genuinely overlap with
 * redline vocabulary and the tool would be much less useful without them.
 */
export function checkRedline(parts: {
  label?: string;
  name?: string;
  id?: string;
  autocomplete?: string;
  type?: string;
}): RedlineMatch | null {
  const normalized = normalizeField(parts);

  // A password input is a redline regardless of how it is labelled. The type attribute
  // is the browser's own statement about what the field holds.
  if (parts.type === 'password') {
    return {
      category: 'credential',
      note: 'A password field. This tool never types into one.',
      matched: 'input[type=password]',
    };
  }

  if (isAllowlisted(normalized)) return null;

  for (const p of REDLINE_PATTERNS) {
    if (p.test.test(normalized)) {
      return { category: p.category, note: p.note, matched: p.test.source };
    }
  }
  return null;
}

/** Phrasing for the pre-submit checklist. */
export function describeSkipped(matches: RedlineMatch[]): string {
  if (matches.length === 0) return 'Nothing was skipped.';
  const n = matches.length;
  return `${n} field${n === 1 ? '' : 's'} left for you to complete. ${
    matches.some((m) => m.category === 'ai_disclosure')
      ? 'One of them asks about AI use; answer that one yourself.'
      : ''
  }`.trim();
}
