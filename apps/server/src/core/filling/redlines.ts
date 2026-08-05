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
 *
 * A NOTE ON PLURALS, WHICH IS NOT A STYLE POINT. Several patterns here name a broad word
 * and then require a second word to pin down the dangerous sense — `medical condition`
 * rather than bare `medical`, `background check` rather than bare `background`. Every one of
 * those second words has to allow its plural. Forms ask in the plural at least as often as
 * the singular: "Do you have any medical conditions?" and "Background checks" are the
 * ordinary phrasings, and while the lists held only the singular those fields matched
 * nothing at all and were filled in like any other question. So each closing noun carries an
 * `s?` before its `\b`, and the irregular ones spell both forms out.
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
  /\b(salary|compensation|pay|wage)\s*(expectation|requirement|range|desired|expected)s?\b/i,
  /\b(desired|expected|target|requested)\s+(salary|compensation|pay|rate)s?\b/i,
  // A username qualified by a public platform is a profile link, not a credential. The
  // credential pattern has to catch a bare "Username" on a sign-up form, so the
  // distinction has to be made here.
  /\b(github|gitlab|linkedin|twitter|x|behance|dribbble|portfolio|stack ?overflow|kaggle|leetcode)\b.{0,12}\b(username|handle|profile|url|id)s?\b/i,
];

/** True when a label is explicitly fine to fill despite resembling a redline. */
export function isAllowlisted(normalized: string): boolean {
  return ALLOWLIST.some((r) => r.test(normalized));
}

export const REDLINE_PATTERNS: RedlinePattern[] = [
  // ── Government and identity numbers ────────────────────────────────────────
  {
    category: 'government_id',
    test: /\b(social security( numbers?| no\.?| #)?|ssn|sin\b|national insurance|nino\b|national id(entity)? (number|card)s?|tax(payer)? (id|identification)s?|\btin\b|\bitin\b)\b/i,
    note: 'A government identification number. Type this yourself if the form requires it.',
  },
  {
    category: 'government_id',
    test: /\b(passport|visa) (number|no\.?|#)s?\b|\bdriver'?s? licen[cs]e( numbers?| no\.?| #)?\b|\bstate id (number|card)s?\b|\balien (registration )?numbers?\b|\buscis\b|\bi-?94\b|\bi-?20\b/i,
    note: 'An identity document number. Type this yourself if the form requires it.',
  },
  {
    category: 'government_id',
    test: /\bdate of birth\b|\bbirth ?date\b|\b\bdob\b/i,
    note: 'Date of birth. Held locally for eligibility filtering only, and never entered into a form.',
  },
  {
    // Abbreviations and punctuation-stripped forms. `normalizeField` flattens `_`, `-` and
    // `.`, so "Soc Sec No." arrives as "soc sec no" — but it leaves `#` alone, which is the
    // only reason `\bss#` below matches anything. Widening that character class to include
    // `#` would silently kill this pattern.
    category: 'government_id',
    test: /\bss#|\bss num\b|\bsoc sec\b|\bssn?\b|\bni numbers?\b|\bni no\b|\bdl (number|num|no)s?\b|\blicen[cs]e (number|num|no)s?\b/i,
    note: 'A government identification number. Type this yourself if the form requires it.',
  },
  {
    // Non-US national identifiers. Without these the tool is only safe for US applicants,
    // which is not a defensible place to stop.
    //
    // "numero de" has to name what the number is OF. On its own it caught "Numero de
    // telefono" and "Numero de telephone", so on a Spanish or French form the phone and
    // street-number fields were all refused as government IDs — the exact non-US applicant
    // this pattern was added to serve got the worst experience on the page. Only the
    // unaccented spellings are listed because `normalizeField` folds the accents away first.
    category: 'government_id',
    test: /\baadhaar\b|\bpan card\b|\bnric\b|\bfin number\b|\bmykad\b|\bcnic\b|\bpersonnummer\b|\bcurp\b|\bhkid\b|\bcodice fiscale\b|\bemirates id\b|\bdni\b|\bnie\b|\bbsn\b|\brut\b|\bc[eé]dula\b|\bcpf\b|\bcnpj\b|\bnif\b|\bsteuernummer\b|\btax file number\b|\btfn\b|\butr\b|\bein\b|\bnumeros? d[eo] (seguridad social|seguro social|securite sociale|identidad|identificacion|identificacao|documento|pasaporte|passaporte|cedula|licencia|contribuinte|carteira)s?\b/i,
    note: 'A national identification number. Type this yourself if the form requires it.',
  },
  {
    category: 'government_id',
    test: /\bgovernment.?issued\b|\bgovt id\b|\bstate.?issued\b|\bidentification documents?\b|\bproof of identity\b|\bid (number|card|document)s?\b|\b(work|residence) permits?\b|\bbrp\b/i,
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
    test: /\b(bank|checking|chequing|savings|deposit) (account|details|form)s?\b|\bacct\b|\baccount (number|holder|no)s?\b|\brouting (number|no\.?)s?\b|\biban\b|\bswift\b|\bsort code\b|\bbsb\b|\bifsc\b|\btransit numbers?\b|\binstitution numbers?\b|\bbranch code\b|\bmicr\b|\bbic\b|\bwire transfer\b|\bvoided che(que|ck)s?\b|\bdirect deposit\b/i,
    note: 'Bank details. This tool never handles payment information.',
  },
  {
    // `cc-number`, `cc-csc`, `cc-exp` are HTML autocomplete tokens, and a form can declare
    // them without any label at all.
    //
    // The expiry branch spells the whole word out instead of stopping at the stem `expir`.
    // A stem followed by `\b` only matches where the word actually ends there, and it never
    // does — so "Card expiration date", the way essentially every payment form labels that
    // box, matched nothing here, and unless the words "credit card" happened to appear in
    // the same label the month and year of someone's card were treated as an ordinary date
    // to fill in.
    category: 'financial',
    test: /\b(credit|debit) cards?\b|\bcard (number|holder|security|verification)s?\b|\bcard expir(y|ies|ation|ations|es|ed)\b|\bcvv\b|\bcvc\b|\bcsc\b|\bcc (number|name|type|csc|exp)s?\b|\bbilling (address(es)?|zips?|postal)\b|\bpaypal\b|\bvenmo\b|\bzelle\b/i,
    note: 'Payment details. This tool never handles payment information.',
  },
  {
    category: 'financial',
    // Matches in either order, because forms phrase this both as "Current salary" and as
    // "What was your salary at your last position?". Safe to be broad here only because
    // the allowlist has already claimed expectation and desired-compensation phrasings.
    test: /\bsalary histor(y|ies)\b|\b(current|previous|prior|last|most recent|former)\s+(salar(y|ies)|compensation|pay|wage)s?\b|\b(salary|compensation|pay|wage|earn(ed|ings)?|paid)\b.{0,40}\b(last|previous|prior|current|most recent|former|history)\b/i,
    note: 'Salary history. Asking this is restricted in several US states, and it is yours to answer or decline.',
  },

  // ── Credentials ────────────────────────────────────────────────────────────
  {
    category: 'credential',
    // Security-question ANSWERS are the part worth naming explicitly. They are phrased as
    // harmless trivia — a first pet, a mother's maiden name, the street you grew up on —
    // and nothing about the wording says "credential", but they unlock account recovery.
    test: /\bpass(word|phrase|code)s?\b|\bpwd\b|\b(security|secret|recovery) (question|answer|word|code)s?\b|\bmemorable word\b|\bpins?\b(?! ?code for)|\bpersonal identification numbers?\b|\b(verification|confirmation|authentication|authenticator|sms|digit)\b\s*(\w+\s+)?codes?\b|\bone[- ]time (code|password)s?\b|\botp\b|\b2fa\b|\busernames?\b|\buser ids?\b|\blogin ids?\b|\bscreen names?\b|\baccount names?\b|\bmaiden names?\b|\bfirst pet\b|\bchildhood\b|\bgrew up on\b|\bfirst teacher\b|\bfavou?rite teacher\b/i,
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
    test: /\bunder (penalty of perjury|oath)\b|\btrue and (complete|correct|accurate)\b|\bto the best of my knowledge\b|\battestations?\b|\b(applicant|candidate|employee) (certification|declaration)s?\b|\b(certification|declaration)s? (statements?|and authorization|of truth)\b|\baffidavits?\b|\bstatements? of truth\b|\bsworn\b|\bnotari[sz]/i,
    note: 'A sworn or certified statement. Only you can make it.',
  },
  {
    category: 'attestation',
    // A bare "Initials" box beside a paragraph is someone signing it, so the word stays.
    // But "Middle initial" is a name field on a great many application forms, and refusing
    // it told the user their middle initial was a signature this tool would not forge.
    test: /\b(e ?)?signatures?\b|\bsignator(y|ies)\b|\bdocusign\b|\bsign (here|below|and date|this)\b|\bplease sign\b|\bsigned (by|date)\b|\bdate of signing\b|\btype your (full )?name to sign\b|(?<!\b(middle|first|last|given|family) )\binitials?\b|\bdate signed\b/i,
    note: 'A signature. This tool does not sign anything on your behalf.',
  },

  // ── Consent: the user's to give ────────────────────────────────────────────
  {
    category: 'consent',
    test: /\bi (agree|consent|authorize)\b|\bterms (of (service|use)|and conditions)\b|\bprivacy polic(y|ies)\b|\baccept the terms\b|\barbitration\b/i,
    note: 'Consent is yours to give. Read it and decide.',
  },
  {
    category: 'consent',
    test: /\bbackground (check|screening|investigation)s?\b|\bcredit checks?\b|\bdrug (test|screen)s?\b|\bconsumer reports?\b|\bfcra\b|\bcontact\b.{0,24}\b(employer|supervisor|manager|references?)\b/i,
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
    test: /\brace\b|\bethnicit|\bhispanic\b|\blatino\b|\bgender\b|\bsex\b|\bpronouns?\b|\bsexual orientation\b|\blgbt/i,
    note: 'Voluntary self-identification. Not this tool’s to answer.',
  },
  {
    category: 'eeo_demographic',
    // `disability (status)?` required a trailing space before the optional word, so the one
    // thing it could not match was the bare label "Disability" that most EEO sections
    // actually use. The optional word now carries its own space.
    test: /\b(protected )?veterans?\b|\bmilitary (services?|status(es)?)\b|\bdisabilit(y|ies)( status)?\b|\bcc-?305\b|\bself[- ]identif/i,
    note: 'Voluntary self-identification. Not this tool’s to answer.',
  },
  {
    category: 'eeo_demographic',
    // `\bmedical\b` alone caught "Medical school", so a med student's own school field was
    // refused as a health disclosure — and because the redline check runs before every
    // classification rule, nothing downstream could recover it. The word needs a second one
    // to establish the health sense, the same way `marketing` does for consent.
    //
    // Every one of those second words allows its plural, and that is the whole point rather
    // than tidiness. "Do you have any medical conditions?" is how a health-disclosure
    // question is worded on almost every form that asks one, and with only the singular
    // spelled out that question matched nothing here: the most common health disclosure on
    // an application was not on the redline list at all, and a free-text box asking about
    // someone's health was treated as an ordinary question to answer for them.
    test: /\breligio|\bpolitical (affiliations?|part(y|ies))\b|\bunion member|\bmarital status\b|\bnumber of (children|dependents)\b|\bhealth (conditions?|information|records?)\b|\bmedical (condition|histor(y|ies)|information|leave|record|exam|examination|screening)s?\b/i,
    note: 'Personal information the tool will not guess at.',
  },
  {
    category: 'eeo_demographic',
    test: /\b(criminal|conviction|convicted|felony|misdemeanor|arrest)\b/i,
    note: 'Criminal history. Yours to answer, and the rules around it vary by jurisdiction.',
  },
  {
    category: 'eeo_demographic',
    test: /\bemergency contacts?\b|\bnext of kin\b|\bin case of emergency\b/i,
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

/**
 * One sentence for a list of skipped fields, with the AI question called out by name.
 *
 * Nothing renders this yet — the pre-submit review lists each skipped field with its own
 * note rather than summarizing them. It is kept for the sentence about AI disclosure, which
 * is the one thing a summary must not fold in with the rest: it is the question the user has
 * to answer deliberately, and burying it in a count is how it gets missed.
 */
export function describeSkipped(matches: RedlineMatch[]): string {
  if (matches.length === 0) return 'Nothing was skipped.';
  const n = matches.length;
  return `${n} field${n === 1 ? '' : 's'} left for you to complete. ${
    matches.some((m) => m.category === 'ai_disclosure')
      ? 'One of them asks about AI use; answer that one yourself.'
      : ''
  }`.trim();
}
