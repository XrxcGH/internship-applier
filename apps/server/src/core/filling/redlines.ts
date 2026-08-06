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
 * A NOTE ON WORD FORMS, WHICH IS NOT A STYLE POINT. Several patterns here name a broad word
 * and then require a second word to pin down the dangerous sense — `medical condition`
 * rather than bare `medical`, `background check` rather than bare `background`. Every one of
 * those second words has to allow every form a form actually prints it in. Forms ask in the
 * plural at least as often as the singular: "Do you have any medical conditions?" and
 * "Background checks" are the ordinary phrasings, and while the lists held only the singular
 * those fields matched nothing at all and were filled in like any other question.
 *
 * The same thing happened again one word class over. `drug (test|screen)s?` caught "Drug
 * test" and "Drug tests" and missed "Drug screening", "Drug screenings" and "Drug testing" —
 * which is how most US forms label that box — so a drug-testing authorization was handed to
 * the answer engine like an ordinary question. And `(criminal|conviction|felony|arrest)`
 * caught "Conviction" but not "Convictions", "Felonies", "Misdemeanors" or "Have you ever
 * been arrested?", so a criminal-history disclosure on a form with opaque field names was
 * filled in from an approved answer.
 *
 * So the rule is one rule, and it covers all three cases: WHENEVER A WORD IS ADDED HERE, ADD
 * EVERY FORM OF IT THAT COULD APPEAR ON A FORM — the plural (`s?`, or both spellings when
 * the plural is irregular), the gerund (`screening`, `testing`), and the inflections of a
 * verb (`arrest`, `arrests`, `arrested`). A pattern that names only the form in front of you
 * reads as if the field is protected while every sibling phrasing walks straight through it,
 * which is the worst kind of gap because nothing about the pattern looks wrong.
 */
import type { RedlineCategory } from '@ia/shared';

export interface RedlinePattern {
  category: RedlineCategory;
  test: RegExp;
  /** Shown to the user in the skipped-fields list. */
  note: string;
}

/**
 * The only categories an allowlist entry is permitted to cancel.
 *
 * `attestation`, `consent`, `eeo_demographic` and `ai_disclosure` are missing from this
 * union deliberately, and their absence is enforced by the compiler rather than by anyone
 * remembering the rule. Those four are the categories where the answer is the user's own
 * statement to make, so no phrasing coincidence in a label is ever a reason to fill one.
 */
type RescuableCategory = Extract<RedlineCategory, 'government_id' | 'financial' | 'credential'>;

interface AllowlistEntry {
  test: RegExp;
  /** The redline categories this phrase may cancel, and nothing beyond them. */
  rescues: readonly RescuableCategory[];
  /** When this also matches, the entry does not apply at all. */
  unless?: RegExp;
}

/**
 * What a qualifier like "current" or "previous" attaches to when it is asking what you are
 * paid — the shape shared by the salary-history redline below and by the allowlist entries
 * that have to know when NOT to excuse one.
 *
 * The two words are allowed up to two ordinary words between them, and that gap is the whole
 * reason this is spelled out once rather than twice. It used to be a bare `\s+`, so the
 * qualifier had to sit immediately against the pay word: "Current salary" was caught and
 * "Current annual salary", "Current base salary", "Current total compensation" and "Most
 * recent annual salary" — the way a form actually prints that box — matched nothing here and
 * were classified `unknown`, so the user was told the tool could not tell what the field was
 * asking rather than being told this is salary history and restricted in several US states.
 *
 * The noun list carries the rate wordings too, because "Current rate of pay" and "Current
 * hourly rate" are the Workday and Greenhouse phrasings and neither contains a pay noun the
 * old list named at all.
 */
const QUALIFIED_PAY = String.raw`\b(current|previous|prior|last|most recent|former)\s+(\w+\s+){0,2}(salar(y|ies)|compensation|pay|wage|rate of pay|hourly rate|pay rate|earnings)s?\b`;

/**
 * A history question does not stop being one because an expectation word appears later in
 * the sentence. "What is your current salary and your expected salary range?" asks for both,
 * and the part that matters is the first half.
 *
 * The lookahead is what separates the two senses when they share the same words: "current
 * salary expectations" is what you are asking for now, while "current salary" followed by
 * anything else — "range", "and", a full stop — is what you are being paid now.
 */
const PAID_IN_THE_PAST = new RegExp(
  QUALIFIED_PAY + String.raw`(?!\s+(expectation|requirement|desired|expected))`,
  'i',
);

/**
 * Phrases that LOOK like redlines but are legitimately fillable, each paired with the
 * categories it is allowed to excuse.
 *
 * The pairing is the entire point of this list, and it was learned the hard way. This used
 * to be a plain array of regexes consulted before the redline table, and one hit anywhere in
 * a label cancelled every pattern below. So the checkbox "I certify that I am legally
 * authorized to work in the United States" — ordinary closing boilerplate on a US
 * application form — was not treated as an attestation at all. It was read as a
 * work-authorization question, answered from the profile, and ticked "Yes": a machine
 * signing a sworn statement in the applicant's name. "I authorize this background check and
 * confirm my work authorization status" was ticked the same way, granting consent to an
 * investigation off the back of an unrelated question, and "Signature: I certify I am
 * legally authorized to work in the US" had the user's legal name typed into it.
 *
 * The list is also much shorter than it was, because most of it was excusing nothing. It used
 * to carry entries for "authorized to work", "require sponsorship", "are you eligible to
 * work", "graduation date" and "start date", and the justification written above them was
 * that a citizenship pattern would otherwise swallow them. There is no citizenship pattern in
 * this file and there never was: run those five phrasings past every regex below and not one
 * of them matches. So the entries rescued nothing while making every pattern in the table
 * cancellable by any label that happened to mention work authorization. They are gone, and
 * the suite asserts those phrasings stay fillable, which is where that guarantee belongs.
 */
const ALLOWLIST: AllowlistEntry[] = [
  // "Work permit status" asks whether the applicant has one; the identity-document pattern
  // reads it as a request for the permit itself. The `unless` is there because an eligibility
  // question does not ask for a number — once a label names a number, a document or a copy,
  // it is asking for the document and this entry steps out of the way. Without it,
  // "Work authorization status / Alien registration number" was excused along with the phrase.
  {
    test: /\bwork (authorization|eligibility|permit|visa) status\b/i,
    rescues: ['government_id'],
    unless: /\b(numbers?|documents?|cop(y|ies)|upload|scan|expir)/i,
  },
  // What you are ASKING for is answerable from the profile. What you were PAID is history,
  // which is a different question and restricted in several states.
  //
  // A bare "range" is not enough to establish the forward-looking sense, and while it was
  // listed here "Current salary range" and "Previous compensation range" — the commonest
  // wording of the restricted question — were allowlisted and filled in with the user's
  // minimum acceptable stipend, presented to an employer as what they are paid today. The
  // unambiguous words stay; "range" now has to arrive attached to one of them, as it does in
  // "Desired salary range".
  {
    test: /\b(salary|compensation|pay|wage)\s*(expectation|requirement|desired|expected)s?\b/i,
    rescues: ['financial'],
    unless: PAID_IN_THE_PAST,
  },
  {
    test: /\b(desired|expected|target|requested)\s+(salary|compensation|pay|rate)s?\b/i,
    rescues: ['financial'],
    unless: PAID_IN_THE_PAST,
  },
  // A username qualified by a public platform is a profile link, not a credential. The
  // credential pattern has to catch a bare "Username" on a sign-up form, so the
  // distinction has to be made here.
  {
    test: /\b(github|gitlab|linkedin|twitter|x|behance|dribbble|portfolio|stack ?overflow|kaggle|leetcode)\b.{0,12}\b(username|handle|profile|url|id)s?\b/i,
    rescues: ['credential'],
  },
];

/**
 * True when the label carries a phrase that is explicitly fine to fill AND that phrase is
 * allowed to excuse this particular category. A phrase that excuses `financial` says nothing
 * about an attestation in the same label.
 */
export function isRescued(normalized: string, category: RedlineCategory): boolean {
  return ALLOWLIST.some(
    (a) =>
      (a.rescues as readonly RedlineCategory[]).includes(category) &&
      !a.unless?.test(normalized) &&
      a.test.test(normalized),
  );
}

// The words that name the tool, the words that name its involvement in producing TEXT, and
// the words that name the thing being submitted — kept apart so the pattern below can
// require them in either order.
//
// `generative` is spelled as the two-word term rather than on its own, and the authorship
// verbs spell "generate", "generated", "generating" and "generation" out instead of stopping
// at the stem `generat`. Both changes exist for the same reason: the stem matched the word
// "generative", so the phrase "generative AI" satisfied BOTH halves of the pattern by
// itself. Every ordinary question about AI skills — "What excites you about generative AI?",
// "Tell us about a project where you used generative AI" — was refused as an AI-disclosure
// question and the note told the applicant it "asks whether AI helped with your
// application", which was not true of any of them.
const AI_TERM = String.raw`(ai|a i|artificial intelligence|chatgpt|copilot|gemini|claude|llms?|(large )?language models?|generative ai|gen ai)`;
// Verbs about who WROTE something. `use` is deliberately not here: "Have you used AI?" is a
// skills question on half the engineering forms in existence, and while `use` counted as
// involvement every one of them was refused. `assist(s|ed|ing|ance)` stops short of
// "assistant" for the same reason — "AI assistant" names a thing you build, not a
// disclosure.
const AI_AUTHORSHIP = String.raw`(writ\w*|wrote|generated?|generates|generating|generation|author(ed|ing|ship)?|compos\w*|draft\w*|disclos\w*|declar\w*|assist(s|ed|ing|ance)?\b)`;
// The thing being handed in. An AI term sitting next to one of these is the disclosure
// question however it is phrased, which is what catches "Did you use ChatGPT for this
// application?" now that `use` no longer counts on its own.
const AI_SUBMISSION = String.raw`(this|these|your|the) ((application|response|answer|essay|submission|statement|questionnaire|form)s?|cover letter|personal statement|writing sample)`;

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
    // `swift` has to name what kind of SWIFT it is. On its own it is also the name of a
    // programming language, so "Which programming languages do you know? (Java, Swift,
    // Python)" and "Describe your experience building iOS apps in Swift" were refused as
    // bank details — on the single most common skills question at any company with a mobile
    // team, with a note telling the applicant the tool never handles payment information.
    // Nothing is lost by requiring the qualifier: a real form says "SWIFT code",
    // "SWIFT/BIC" or "SWIFT number" and never the bare word.
    test: /\b(bank|checking|chequing|savings|deposit) (account|details|form)s?\b|\bacct\b|\baccount (number|holder|no)s?\b|\brouting (number|no\.?)s?\b|\biban\b|\bswift[ /]?(codes?|bic|numbers?|no\.?)\b|\bsort code\b|\bbsb\b|\bifsc\b|\btransit numbers?\b|\binstitution numbers?\b|\bbranch code\b|\bmicr\b|\bbic\b|\bwire transfer\b|\bvoided che(que|ck)s?\b|\bdirect deposit\b/i,
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
    //
    // The bare `\bcsc\b` that used to sit beside `cvv` is gone, because CSC is also a course
    // prefix at a great many US universities. "Relevant coursework (e.g. CSC 226, MATH 241)"
    // and "Which CSC electives have you completed?" were refused as payment details, and the
    // placeholder route makes that worse than it sounds: an unlabelled input takes its
    // placeholder as its label, so a box whose only hint is "e.g. CSC 226" is refused too.
    // The card sense loses nothing — "Card security code" is already caught by the branch
    // before this one, and the `cc-csc` autocomplete token by the branch after it.
    category: 'financial',
    test: /\b(credit|debit) cards?\b|\bcard (number|holder|security|verification)s?\b|\bcard expir(y|ies|ation|ations|es|ed)\b|\bcvv\b|\bcvc\b|\bcc (number|name|type|csc|exp)s?\b|\bbilling (address(es)?|zips?|postal)\b|\bpaypal\b|\bvenmo\b|\bzelle\b/i,
    note: 'Payment details. This tool never handles payment information.',
  },
  {
    category: 'financial',
    // Matches in either order, because forms phrase this both as "Current salary" and as
    // "What was your salary at your last position?". It can afford to be this broad because
    // the expectation phrasings in the allowlist can pull a label back out of `financial`
    // — and only out of `financial`, so a label that pairs a salary question with an
    // attestation still stops here.
    //
    // The qualified-pay half is shared with the allowlist's `unless`, so widening it widens
    // both halves of the mechanism at once. When they were written out separately, one of
    // them would inevitably go on describing the behaviour the other had stopped having.
    test: new RegExp(
      String.raw`\bsalary histor(y|ies)\b|${QUALIFIED_PAY}|\b(salary|compensation|pay|wage|earn(ed|ings)?|paid)\b.{0,40}\b(last|previous|prior|current|most recent|former|history)\b`,
      'i',
    ),
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
    // Forms phrase these in the first, second AND third person ("The applicant certifies",
    // "By checking this box, you certify"), and several jurisdictions use their own noun
    // for it.
    //
    // THE SECOND PERSON IS ITS OWN BRANCH, not another word in the pronoun list, because
    // "you" is in half the labels on an application form and the verbs are not all verbs.
    // While it was missing, "By checking this box, you certify that the information
    // provided is accurate" was not an attestation at all, and phrased as a question —
    // "Do you certify that everything you have provided is accurate and complete?" — it
    // was long enough and interrogative enough to be classified as an essay at 0.85, so an
    // approved answer of "Yes" ticked the box. A machine signed a sworn statement in the
    // applicant's name with no redline anywhere in the way.
    //
    // The branch requires "you" immediately before the verb, and the verbs that also have
    // an innocent everyday sense have to bring "that" with them. Without those two
    // restrictions "Have you declared a major?", "Which organization do you represent?" and
    // "Do you have any certifications?" were all refused as sworn statements, which is the
    // opposite mistake on fields a student form asks every time.
    //
    // THE VERB LIST IS THE WEAK PART OF THIS RULE, so it is worth saying why each word is
    // here. "confirm" was missing, and "By checking this box I confirm I am authorized to
    // work in the US" is at least as common on US forms as the "certify" wording — it was
    // classified work_auth at 0.94 and ticked "Yes", which is the tool making a legal
    // statement in someone's name. "verify", "warrant" and "represent" are the same shape.
    // Anything of the form "I <verb> that ..." where the verb commits the applicant to the
    // truth of something belongs here; when adding one, add its test alongside.
    //
    // "understand" is the commonest verb in the closing boilerplate of a US application — "I
    // understand that any false statement or omission on this application may result in
    // refusal of employment or dismissal" — and it was not on the list. That checkbox was not
    // an attestation at all, and phrased as a question ("Do you understand and agree that any
    // misrepresentation may result in dismissal?") it was long enough and interrogative
    // enough to be classified as an essay at 0.85, so an approved answer of "Yes" ticked it —
    // exactly the failure the second-person branch above was added to stop, reached through a
    // different verb. It brings "that" or "and agree" with it, because "Do you understand the
    // role?" is an ordinary question and has to stay fillable.
    //
    // The last branch is the imperative, which has no subject in it at all. "Please confirm
    // that the information above is accurate" is the same sworn statement with the pronoun
    // dropped, and it needs "that" for the same reason, so "Confirm your email address" is
    // untouched.
    test: /\b(i|applicant|candidate|undersigned)\b.{0,24}\b(certif|attest|affirm|declare|acknowledge|swear|confirm|verif|warrant|represent)|\byou\b\s+(hereby\s+)?(certif(y|ies)|attests?|affirms?|acknowledges?|swears?|confirms?|(declares?|represents?|warrants?|verif(y|ies))\s+that\b)|\b(certify|attest|affirm|acknowledge|declare|confirm|swear)\s+(that\s+)?you\b|\bhereby\b.{0,24}\b(certif|attest|affirm|declar|acknowledg|swear|warrant|represent)|\b(i|you|we|applicant|candidate|undersigned)\s+(hereby\s+)?understands?\s+(that\b|and\s+agrees?\b)|\b(please\s+)?(certify|confirm|acknowledge|attest|affirm|declare|verify)\s+that\b/i,
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
    // CONSENT IS ASKED IN EVERY PERSON, and the rule only recognised the first one. While it
    // was `\bi (agree|consent|authorize)\b`, "I agree to the terms" was caught and "You
    // consent to the processing of your personal data", "Do you agree to receive SMS text
    // messages at the number provided?" and "By submitting, you authorize us to verify the
    // information provided" were not consent at all — a standard TCPA or GDPR checkbox
    // reached the essay path, where an approved answer of "Yes" ticks it. Same asymmetry the
    // attestation rule had, same fix: the second and third person get their own branch.
    //
    // "you agree" has to bring "to" with it. "Do you agree with the following statement" is a
    // work-style assessment item and refusing those would be the opposite mistake; "consent"
    // and "authorize" need no such guard because neither has an innocent sense here.
    //
    // The bare noun is a branch of its own, because half of these boxes have no verb in them
    // at all — "Consent", "Data processing consent", "Consent to receive text messages" are
    // whole labels as printed. Unlike `marketing` or `medical`, which had to be narrowed
    // because they name a major and a kind of school, "consent" has no ordinary sense on an
    // application form, so the bare word is safe to refuse on.
    test: /\b(i|we|the applicant|applicant|candidate)\s+(hereby\s+)?(agrees?|consents?|authorizes?|permits?)\b|\byou\s+(hereby\s+)?(consents?|authorizes?|permits?)\b|\byou\s+(hereby\s+)?agrees?\s+to\b|\bdo you (consent|authorize|permit|agree to)\b|\bconsent(s|ed|ing)?\b|\bterms (of (service|use)|and conditions)\b|\bprivacy polic(y|ies)\b|\baccept the terms\b|\barbitration\b/i,
    note: 'Consent is yours to give. Read it and decide.',
  },
  {
    category: 'consent',
    // Every noun here carries its gerund as well as its plural, and that is the whole point
    // rather than tidiness. While the list read `drug (test|screen)s?` it caught "Drug test"
    // and "Drug tests" and missed "Drug screening", "Drug screenings", "Drug testing" and
    // "Pre-employment drug screening" — which is how most US forms label that box — so a
    // drug-testing authorization was not on the redline list at all. Its sibling clause in
    // this very pattern already spelled "background screening" out, which is how the gap
    // survived: the phrasing in front of whoever wrote it happened to be the one that worked.
    //
    // "drug and alcohol" and "substance abuse" are the same box under a different name, and
    // "background verification" is the wording most large employers use now.
    test: /\bbackground (check|screen|screening|investigation|verification)(s|ing|ings)?\b|\bcredit (check|report)(s|ing|ings)?\b|\b(drugs?|alcohol|drugs? and alcohol|substance abuse|controlled substances?) (test|screen|analysis)(s|es|ing|ings)?\b|\bconsumer reports?\b|\bfcra\b|\bcontact\b.{0,24}\b(employers?|supervisors?|managers?|references?)\b/i,
    note: 'An authorization to investigate you. Yours to give.',
  },
  {
    category: 'consent',
    // PERMISSION TO CONTACT SOMEONE IS ITS OWN QUESTION, and it was only recognised when the
    // party named happened to be one of four workplace words. "May we contact your current
    // employer?" was caught; "May we contact your school?", "Do you give permission for us to
    // contact your university?" and "Permission to contact your registrar" were classified as
    // school fields at 0.9 confidence and the tool typed the applicant's institution name
    // into them — an answer to a question nobody asked, in a box where the applicant was
    // being asked to grant or withhold permission.
    //
    // So the rule stops naming parties. WHO is being contacted does not matter — a registrar,
    // a professor, a coach, a landlord — what makes the field a redline is that the label
    // asks whether it MAY happen. That also means the pattern can never again be one noun
    // short of the form in front of it.
    //
    // The lookahead excludes contacting the APPLICANT: "How can we contact you?" asks for a
    // phone number, and refusing to fill that is the over-blocking this table is meant to
    // avoid. "your school" is untouched by it, because "you" does not end at a word boundary
    // inside "your".
    test: /\b(may|might|can|could|ok|okay|alright|permission|permitted|permit|authoriz\w*|consent\w*|agree\w*|approv\w*|allow\w*)\b[^?]{0,32}\bcontact\w*\b(?!\s+(you|me|us)\b)|\bcontact\w*\b[^?]{0,32}\b(permission|permitted|authoriz\w*|consent\w*|approval)\b/i,
    note: 'Permission to contact someone about you. Yours to give.',
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
    // `\brace\b` steps aside for "race condition", the way `medical` steps aside for "Medical
    // school" further down. "Describe a time you debugged a race condition in concurrent
    // code" is an ordinary CS essay prompt, and it was refused with a note telling the
    // applicant it was voluntary self-identification — so the answer they had drafted and
    // approved was dropped and the explanation they were given was untrue of the question.
    // Nothing demographic is lost: the exclusion is only the two-word phrase, and "racial"
    // is spelled out so narrowing the noun does not cost the adjective.
    test: /\brace\b(?!\s+conditions?\b)|\bracial\b|\bethnicit|\bhispanic\b|\blatino\b|\bgender\b|\bsex\b|\bpronouns?\b|\bsexual orientation\b|\blgbt/i,
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
    // This pattern had both mistakes at once, which is unusual and worth spelling out.
    //
    // It was singular-only. `(conviction|felony|misdemeanor|arrest)` caught "Conviction" and
    // let "Convictions", "Felonies", "Misdemeanors", "Arrests" and "Arrested" through — and
    // bare plural headings are exactly how a US background-disclosure section labels itself.
    // "Have you ever been arrested? If yes, please explain the circumstances." matched
    // nothing, so on a form with generated field names (a Greenhouse `q_9812`, a Workday
    // `input-42`) it was classified as an essay and an approved answer was typed into a
    // criminal-history disclosure. The verbs now carry their inflections, not just their
    // plurals: "arrest", "arrests", "arrested".
    //
    // And bare `criminal` was too broad in the other direction, because Criminal Justice is a
    // real US undergraduate major. "Why are you interested in a career in criminal justice?"
    // was refused as a criminal-history question — on precisely the law-enforcement and
    // public-defender postings that major applies to — with a note about jurisdiction that
    // was untrue of the question. So `criminal` now needs a second word establishing the
    // record sense, the same way `medical` and `marketing` do above.
    //
    // "probation" is deliberately absent: academic probation is a real thing a student form
    // asks about, and it is not a criminal record.
    test: /\bcriminal (records?|histor(y|ies)|backgrounds?|charges?|convictions?|offen[cs]es?|proceedings?|activit(y|ies)|conduct|disclosures?|matters?|cases?)\b|\bconvict(ed|ion|ions)\b|\bfelon(y|ies)\b|\bmisdemeano(u)?rs?\b|\barrest(s|ed)?\b|\bincarcerat|\bexpunge|\bparole\b|\b(pled|plead|pleaded) (guilty|no contest|nolo)\b|\b(convicted|charged|guilty|committed|accused|indicted)\b.{0,32}\bcrimes?\b/i,
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
    // Both word orders, because a form is as likely to put the verb first. The AI term used
    // to have to come before the verb — anything else needed the single word "use" or "used"
    // in front of it — so "Was any part of this written with the help of ChatGPT?" and "Did
    // AI help write this?" matched nothing. Half the natural phrasings of the one question
    // this category exists for were being handed to the answer-drafting engine instead of
    // raised, which is the tool writing the applicant's answer about whether the tool wrote
    // their answers.
    //
    // The verbs carry their noun forms too ("AI usage disclosure" is a bare section heading
    // with no verb in it anywhere), and the term list spells "a i" rather than "a.i.":
    // `normalizeField` strips the full stops before any pattern sees the string, so the
    // punctuated spelling could never have matched.
    //
    // Two ways in, and the second is what keeps the first from having to be greedy. Either
    // the AI term sits near a word about who WROTE something, or it sits near the name of
    // the thing being handed in. Mere co-occurrence with "use" is not enough, because that
    // is every AI skills question ever asked.
    test: new RegExp(
      String.raw`\b${AI_TERM}\b.{0,40}\b${AI_AUTHORSHIP}|\b${AI_AUTHORSHIP}\w*\b.{0,40}\b${AI_TERM}\b` +
        String.raw`|\b${AI_TERM}\b.{0,40}\b${AI_SUBMISSION}\b|\b${AI_SUBMISSION}\b.{0,40}\b${AI_TERM}\b`,
      'i',
    ),
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
      // "&" is spelled out rather than dropped, because every pattern here that names it
      // names it as a word. A checkbox reading "I have read and agree to the Terms &
      // Conditions" matched no consent pattern and no classification rule either, so the
      // user was told the tool "could not tell what this field is asking for" about the
      // single most recognizable consent box on the page, instead of "Consent is yours to
      // give". Dropping the character would join the words instead — "Terms  Conditions".
      .replace(/&/g, ' and ')
      .replace(/[_\-.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * The decision. Returns a match when the field must not be filled.
 *
 * Every pattern is tested, and the allowlist is asked about each match one category at a
 * time. That ordering matters: a phrase that legitimately excuses a bank-details pattern has
 * no bearing on an attestation in the same label, and the loop keeps going after a rescue so
 * a later, un-rescuable match is still found.
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

  for (const p of REDLINE_PATTERNS) {
    if (!p.test.test(normalized)) continue;
    if (isRescued(normalized, p.category)) continue;
    return { category: p.category, note: p.note, matched: p.test.source };
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
