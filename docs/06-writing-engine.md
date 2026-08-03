# 06 — Writing engine

This module produces the free-text answers on an application: cover-letter-style fields,
"why this company," "describe a project," short-answer essays. It has two jobs that are
easy to confuse and must stay separate:

- **Say true things.** Every claim traces to a confirmed profile fact. This is enforced.
- **Say them the way the user would.** Style transfer from the user's own writing.

## What "human writing style" means here

The goal is text the user would plausibly have written, because it is built from their
facts and shaped by their measured writing habits — and because they read and revise it
before it goes anywhere. It is a writing assistant that sounds like *you*, not a generic
"make it undetectable" filter.

Two things follow from that framing, and both are in the design:

- The style target is the user's own `StyleProfile`, computed from real samples. There is
  no "sound more human" prompt in this system, because that produces a different generic
  register, not the user's.
- The tool never claims authorship on the user's behalf. If a form asks about AI
  assistance, that field is redlined (doc 07) and left for the user.

Worth surfacing to the user during onboarding, once, without nagging: some employers ask
about AI use and some treat undisclosed use as grounds for withdrawal. The tool's job is to
make an honest answer easy — draft from your facts, in your voice, reviewed by you — not to
make the question go away.

## Building the voice model

### Input

During onboarding the user pastes 2–5 samples of their own writing — a college essay, an
email to a teacher, a past cover letter, a long Slack/Discord message. 300+ words total is
enough to be useful; 1000+ is good. Samples are stored 🔒 and never sent anywhere except
as few-shot context in drafting calls.

If the user has no samples, the tool says so plainly and falls back to a neutral,
plain-register default — and marks generated answers as "generic voice" in the UI so the
user knows to edit more heavily.

### Measurement

`styleProfile.ts` computes the `StyleProfile` (schema in doc 03) with plain text analysis —
no LLM needed for the metrics themselves:

- Sentence length mean **and standard deviation.** The stdev is the important one: uniform
  sentence length is the single loudest tell of machine-generated prose, and most people
  write with high variance.
- Contraction rate, first-person density, hedge rate.
- Punctuation habits — em-dash vs parenthetical vs semicolon, exclamation frequency.
- Paragraph length distribution; list usage.
- Favored transitions and opening patterns, extracted as literal n-grams from the samples.
- Vocabulary tier via a frequency-band lookup.

A short LLM pass adds qualitative notes (register, warmth, directness, humor) that the
metrics can't capture. These go into the drafting prompt as guidance, not as rules.

## Drafting an answer

```
question + field constraints (max length, tone hints from the form)
        │
        ▼
  ① retrieve relevant profile facts   ← deterministic + embedding retrieval
        │
        ▼
  ② check the answer library          ← reuse an approved canonical answer if one fits
        │
        ▼
  ③ generate  (claude-opus-5, StyleProfile + few-shot from real samples)
        │
        ▼
  ④ factGuard  — every claim ↔ profile evidence, or flag
        │
        ▼
  ⑤ styleCritic — measure against StyleProfile, revise if drifting
        │
        ▼
  ⑥ tell-scrub  — flag known AI-register phrasing for user review
        │
        ▼
     draft + evidence + flags  →  G3 review UI
```

### ① Retrieval, not invention

The prompt is given a bounded evidence set, not the whole profile: the experience bullets,
projects, courses, and skills most relevant to the question and the posting. Retrieval is
hybrid — keyword/skill overlap first, embedding similarity second. Each evidence item
carries its `profileRef` so the generated text can cite it.

The system prompt states the constraint directly: *use only the supplied facts; if the
question asks for something not in the evidence, say so in a `needs_input` field rather
than inventing it.* When that fires, the UI asks the user for the missing detail instead of
producing a plausible fabrication.

### ② Answer library

Recurring questions (`why_this_company`, `greatest_strength`, `describe_a_project`,
`why_this_role`, `tell_us_about_yourself`) map to `answer_template` rows. Once the user has
approved a canonical answer, later applications adapt it — company-specific details swapped
in, length adjusted — rather than generating from scratch. Benefits: less generation
surface area for errors, and a consistent story across applications, which matters if two
recruiters at the same company compare notes.

### ③ Generation

`claude-opus-5`, adaptive thinking, `effort: 'high'`. Prompt structure, ordered for cache
stability:

1. **[cached]** System prompt: role, hard constraints, the no-invention rule.
2. **[cached]** The confirmed profile summary.
3. **[cached]** `StyleProfile` metrics + qualitative notes + 2 verbatim writing samples.
4. Posting context (company, role, relevant requirement quotes).
5. Retrieved evidence set.
6. The question, with its length and format constraints.

Items 1–3 are the stable prefix and carry the `cache_control` breakpoint; they're identical
across every answer for a given user, so per-answer cost is dominated by the small tail.

### ④ FactGuard

The anti-hallucination gate, and the reason this tool is safe to use on a job application.

The draft is decomposed into claims (sentence-level, with sub-clause splitting for compound
sentences). Each claim is classified:

| Verdict | Meaning | UI treatment |
| --- | --- | --- |
| `supported` | Maps to a specific profile fact | Green underline; hover shows the evidence |
| `inferred` | Reasonable restatement (e.g. "I enjoy backend work" from three backend projects) | Amber; shown with the inference stated |
| `unsupported` | No profile basis | **Red. Blocks approval** until edited or explicitly acknowledged |
| `overstated` | Supported fact, inflated (2 months → "extensive experience") | Red, with the original fact quoted alongside |

Implementation: a verification call (`claude-opus-5`, `strict` structured output) that
receives the draft plus the evidence set and returns per-claim verdicts with the specific
`profileRef` or a reason for failure. Numbers, dates, titles, and organization names get an
additional deterministic check — exact string/date comparison against the profile — because
those are the highest-consequence errors and don't need a model's judgment.

`unsupported` and `overstated` flags are hard blockers on `approved_at`. The user can
override by editing the text, or by clicking "this is true, it's just not on my resume" —
which prompts them to add the fact to the profile, so the next answer knows it too.

### ⑤ StyleCritic

Measures the draft with the same analyzer used on the samples and compares to the target
`StyleProfile`. If sentence-length stdev, contraction rate, paragraph shape, or punctuation
habits drift beyond a tolerance, a revision pass rewrites toward the target — with an
explicit instruction not to change any factual content, followed by a re-run of FactGuard on
the revision. Style edits must never silently alter facts.

### ⑥ Tell-scrub

A lint pass over known machine-register patterns. It **flags**, it doesn't silently rewrite
— the user decides:

- Opener clichés: "I am excited to apply", "I am writing to express my interest".
- Overused abstractions: "delve", "tapestry", "landscape", "leverage" (as a verb),
  "in today's fast-paced world", "passionate about" (unless it's in the user's samples).
- Structural tells: three consecutive triadic lists; every paragraph the same length;
  `Furthermore`/`Moreover`/`Additionally` stacked as paragraph openers; perfectly
  symmetrical intro-body-conclusion in a 150-word answer.
- Em-dash density above the user's measured rate.
- Uniform sentence length (stdev below the user's measured floor).

Each flag is a UI suggestion with a one-click "rewrite this span" action.

## G3 — The review gate

Not a rubber stamp. The workspace shows, per question:

- The question exactly as it appears on the form, with its length limit and a live counter.
- The draft in an editor.
- An evidence panel: every claim, its verdict, and the profile fact behind it.
- Flags, each with an inline fix action.
- An **edit distance meter.** If the user approves a draft with zero edits, the confirm
  dialog says so: *"You haven't changed anything. Read it once more — you're the one
  signing this."* It doesn't block, but it doesn't let the moment pass silently either.

`approved_at` is set only by an explicit per-answer action. Form filling refuses to start
while any answer is unapproved (doc 03, invariant 2).

## What the engine will not do

- Fabricate experience, skills, dates, GPAs, employers, or references.
- Claim proficiency the profile doesn't evidence.
- Write in a voice the user hasn't provided samples for and then pass it off as tuned.
- Answer AI-disclosure questions (redlined — doc 07).
- Produce text that is submitted without the user having read it (structurally impossible:
  `approved_at` is required, and it's set by a UI action, not by any generation path).
