# 12 — Design language

## The idea: a working dossier

This app handles your resume, your voice, and your record of who you asked for a job. Its
whole design thesis is *receipts* — every filter decision quotes the job description that
caused it, every generated sentence points at the profile fact behind it, every gate is a
signature you supply. The interface should feel like a **case file you are building and
signing**, not a SaaS dashboard.

So: editorial type, rules and marginalia, stamps for state changes, and a surface that reads
as a working surface rather than a canvas. Dark is the primary theme and light is a real
alternative, not an inversion.

> The palette below is the **drafting table** — cool graphite with one azure accent. It
> replaced an earlier warm scheme ("archival ink on warm paper", a brass accent), and this
> document described that older one long after it was gone: every hex value and every
> contrast ratio in it was stale. The values here were re-measured against
> `apps/web/src/index.css` as it ships.

What this deliberately isn't: a purple gradient on white, a grid of rounded cards with
drop shadows, Inter at three weights, an emoji in every heading.

## Typography

Three faces, each with a job. All **self-hosted via `@fontsource`** — the app promises
nothing leaves your machine, so pulling fonts from a CDN would leak a request on every
launch and break offline use. The privacy stance and the type stack have to agree.

| Role | Face | Why |
| --- | --- | --- |
| Display — headings, numerals, the running head | **Instrument Serif** | High-contrast, slightly editorial, a little sharp. Carries a page without shouting. Its italic is genuinely lovely and does the work of a second weight. |
| Body — prose, job descriptions, generated answers | **Newsreader** | Variable serif with optical sizing, built for reading long text on screen. Job descriptions and drafted essays are the two longest things a user reads here; they deserve a reading face, not a UI face. |
| Data — scores, quotes, field labels, evidence refs | **IBM Plex Mono** | A grotesque mono with real personality. Used for anything that is *quoted or measured* — verbatim JD text, field keys, token counts — so the eye learns that mono means "this is evidence, not our words." |

That last rule is the important one: **mono is semantic here, not decorative.** If it's set
in Plex Mono, it came from somewhere else and can be traced.

Scale is a modular 1.2 ratio off a 16px base, with display sizes set tighter
(`letter-spacing: -0.02em`) and small caps used for section eyebrows.

## Color

A cool graphite base, one azure accent that reads like a technical pen, and three signal
colours that each mean exactly one thing. Defined as CSS custom properties in
`apps/web/src/index.css`; both themes ship.

```
                     dark (default)      light
--paper              #0f1418             #eaeef3      the page
--paper-raised       #161d23             #f6f8fb      cards, panels
--paper-sunk         #0a0e11             #dde3ea      wells, tracks
--ink                #e7ecf1             #121820      body
--ink-dim            #a8b3bf             #48545f      secondary
--ink-faint          #8b97a4             #525e6b      eyebrows, small print
--rule               #2f3a45             #b7c2cf      hairlines
--rule-strong        #556575             #748498      structural dividers
--accent             #6ba7f5             #15529e      THE accent. Used sparingly.
--verified           #5cba8a             #226644      claim supported, rule passed
--caution            #dda44a             #8a5610      unknown / needs your input
--redline            #ec7d72             #ad3628      redlined field, unsupported claim
```

Discipline: **azure is the only decorative colour.** Green, amber and coral are reserved for
the verification states in docs/05 and docs/06 — if something is green it means a claim was
verified, not that it is a nice button. A UI where colour is load-bearing cannot also use
colour for flair.

## Background and depth

Not flat fills, and no images:

1. A **drafting grid** — a repeating linear gradient at low alpha (`--grid-alpha`), so
   surfaces read as a working surface rather than as `<div>`s.
2. A soft **glow** — an off-centre radial gradient (`--glow-alpha`), which is what keeps the
   dark theme from reading as a black rectangle.

Both alphas are tokens, so the depth can be tuned in one place per theme.

## Motion

One orchestrated arrival beats twenty fidgety micro-interactions.

- **Page load:** a staggered reveal down the page via `animation-delay` steps of 60ms —
  masthead, then each section, then list rows. CSS only.
- **Stamps:** state changes that represent a human decision (approve a posting, approve an
  answer, mark submitted) animate as a rubber stamp — a fast scale-down from 1.4 with a
  slight rotation and an opacity settle. These are the moments the whole app is about, so
  they're the only place with a showy animation.
- **Rules draw in:** section hairlines animate `scaleX` from 0 on first paint.
- Everything respects `prefers-reduced-motion: reduce`, which collapses all of the above to
  a plain opacity fade.

## Layout

Editorial, not dashboard:

- A **running head** across the top — project name, current section, and the gate you're at
  — set in small caps with a hairline under it. It's a document header.
- **Numbered sections** (`01`, `02`) in the margin, mono, dim. Reinforces "file, in order."
- Asymmetric measure: prose columns cap at ~68ch for readability; data tables run full width.
- Hairline rules instead of card borders and shadows wherever possible. Cards are for things
  you can act on; everything else is ruled sections.

## Components carrying meaning

| Element | Treatment |
| --- | --- |
| Verbatim JD quote | Plex Mono, `--ink-dim`, left accent hairline border, slight indent — a pull quote from a source |
| Requirement pass/fail | Icon + text + color; never color alone |
| Claim highlight | Underline in the verdict color, not a background fill — the text stays readable |
| Redlined field | Oxblood hatch pattern (repeating-linear-gradient), not a plain red box — reads as "struck out," not "error" |
| Gate | Numbered `G1`–`G4` in mono, with the stamp animation on completion |
| Score bar | Thin ruled bar with an accent fill, breakdown shown as stacked hairlines |

## Accessibility, which the aesthetic must not cost

### Measured contrast

Not asserted — computed against the tokens as they ship. Every value is a ratio against
`--paper` in that theme. Target: every text colour ≥ 4.5:1 against all three surfaces.

| Token | Dark | Light |
| --- | --- | --- |
| `--ink` (body) | 15.58 | 15.31 |
| `--ink-dim` | 8.70 | 6.65 |
| `--ink-faint` (eyebrows, small print) | 6.23 | 5.68 |
| `--accent` | 7.47 | 6.60 |
| `--verified` | 7.80 | 5.91 |
| `--caution` | 8.37 | 5.27 |
| `--redline` | 6.83 | 5.40 |

`--rule` sits at about 1.6 in both themes and is decorative by design — a hairline, never
a carrier of meaning. `--rule-strong` is the structural divider. The lowest text ratio
anywhere, across all three surfaces in both themes, is 4.75 (`--caution` on light
`--paper-sunk`).

Light mode failed three of these on its first pass and the tokens were deepened until it
did not. Re-measure after any palette edit: the ratios are cheap to compute and the claim
is worthless unchecked. The numbers above were re-measured when this document was corrected,
because for a while it described a palette the app no longer had — which is the failure mode
this instruction exists to prevent.
- Color is never the only signal — every state has an icon and a text label.
- Focus rings are a 2px accent outline with a 2px offset, visible on every interactive
  element, never removed.
- `prefers-reduced-motion` and `prefers-color-scheme` both honored; theme is also
  manually overridable.
- Serif body text is set at 17px with generous leading, which reads better than 14px sans
  for the long-form content this app is full of.
