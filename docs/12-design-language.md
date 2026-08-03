# 12 — Design language

## The idea: a working dossier

This app handles your resume, your voice, and your record of who you asked for a job. Its
whole design thesis is *receipts* — every filter decision quotes the job description that
caused it, every generated sentence points at the profile fact behind it, every gate is a
signature you supply. The interface should feel like a **case file you are building and
signing**, not a SaaS dashboard.

So: archival ink on warm paper. Editorial type. Rules and marginalia. Stamps for state
changes. Dark mode is the same document under a reading lamp, not an inverted app.

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

Dominant warm ink, one brass accent, and three signal colors that each mean exactly one
thing. Defined as CSS custom properties in `apps/web/src/index.css`; both themes ship.

```
                     dark (default)      light
--paper              #14110E             #EDE6D8      warm near-black / oatmeal
--paper-raised       #1D1915             #E4DBC9
--ink                #E9E2D4             #221E18
--ink-dim            #9A9184             #6B6459
--rule               #2E2823             #CFC4AE      hairlines, ledger rules
--brass              #C8963E             #9A6E1E      THE accent. Used sparingly.
--verified           #7A9471             #4E6B47      claim supported, rule passed
--caution            #C08A4A             #8A5A18      unknown / needs your input
--redline            #A6483F             #8C3328      redlined field, unsupported claim
```

Discipline: **brass is the only decorative color.** Green, amber, and oxblood are reserved
for the verification states in docs/05 and docs/06 — if something is green it means a claim
was verified, not that it's a nice button. A UI where color is load-bearing can't also use
color for flair.

## Background and depth

Not flat fills. Three layers, all CSS, no images:

1. A **paper grain** — a very low-opacity repeating radial gradient, ~2% alpha.
2. **Ledger rules** — a repeating linear gradient of hairlines at the baseline rhythm, ~3%
   alpha, so surfaces read as ruled paper rather than as `<div>`s.
3. A soft **lamp vignette** — an off-center radial gradient, warm, which is what makes the
   dark theme read as "document under a light" instead of "dark mode."

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
| Verbatim JD quote | Plex Mono, `--ink-dim`, left brass hairline border, slight indent — a pull quote from a source |
| Requirement pass/fail | Icon + text + color; never color alone |
| Claim highlight | Underline in the verdict color, not a background fill — the text stays readable |
| Redlined field | Oxblood hatch pattern (repeating-linear-gradient), not a plain red box — reads as "struck out," not "error" |
| Gate | Numbered `G1`–`G4` in mono, with the stamp animation on completion |
| Score bar | Thin ruled bar with a brass fill, breakdown shown as stacked hairlines |

## Accessibility, which the aesthetic must not cost

### Measured contrast

Not asserted — computed against the actual tokens. Every value is a ratio against
`--paper` in that theme. Target: body ≥ 7:1, every other text color ≥ 4.5:1.

| Token | Dark | Light |
| --- | --- | --- |
| `--ink` (body) | 14.60 | 13.35 |
| `--ink-dim` | 7.04 | 7.09 |
| `--ink-faint` (11px eyebrows) | 4.95 | 4.51 |
| `--brass` | 7.07 | 5.14 |
| `--verified` | 5.65 | 4.81 |
| `--caution` | 6.25 | 4.76 |
| `--redline` | 5.09 | 6.46 |

The first pass of this palette failed twice and was corrected: `--ink-faint` came in at
3.17 (it sets the 11px section eyebrows, which are real UI text, not decoration) and dark
`--redline` at 3.24. Light-mode brass then failed at 3.66 because it labels the 13px gate
IDs, so it deepened from `#9a6e1e` to a bronze `#7e5810`. Re-measure after any palette
edit; the ratios are cheap to compute and the claim is worthless unchecked.
- Color is never the only signal — every state has an icon and a text label.
- Focus rings are a 2px brass outline with a 2px offset, visible on every interactive
  element, never removed.
- `prefers-reduced-motion` and `prefers-color-scheme` both honored; theme is also
  manually overridable.
- Serif body text is set at 17px with generous leading, which reads better than 14px sans
  for the long-form content this app is full of.
