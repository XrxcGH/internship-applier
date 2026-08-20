/**
 * The one selector that decides what counts as a fillable control.
 *
 * It lived in two places — the page scanner and the fill executor's index-locator
 * fallback — and the two could drift, which meant the executor could resolve an index to
 * a different element than the scanner meant. The scanner cannot import anything, since
 * Playwright serializes it into the page with nothing around it, so `scanExpression` in
 * formMap.ts passes this string in as an argument instead of the scanner keeping a copy.
 * Anything else that needs it imports it from here.
 *
 * THE EXCLUSIONS ARE A G4 CONCERN, not tidiness. `input[type=image]` is a graphical
 * submit button: the fill path clicks an element before typing into it, and clicking one
 * of those submits the form. `type=reset` would wipe everything already filled. Neither
 * is a text field, but both match a naive `input` selector.
 */
/**
 * A button this tool will not touch, and the reason it is spelled this way.
 *
 * `<button>` with no `type` attribute IS `type="submit"` — the HTML default, not a quirk —
 * so clicking one inside a form submits it. The exclusions above covered that for `input`
 * and stopped there, while `[role=combobox]` matched ANY element carrying the role,
 * `<button role="combobox">` among them. That is a real widget pattern, the fill path's
 * first act on a combobox is to click it open (fill.ts), and `[role=option]` had the same
 * hole one level down. So the one invariant this whole codebase is built around — that no
 * code path ever clicks a control that can submit — had a gap wide enough for an ordinary
 * hand-rolled ATS dropdown to fall through, on a half-filled application.
 *
 * `scripts/g4-scan.ts` could not see it: it looks for the word "submit" and for
 * `[type=submit]`, and this click had neither.
 *
 * Only `type="button"` is safe. `type="reset"` wipes the form, `type="submit"` and the
 * absent attribute both send it, and an unrecognised value falls back to submit.
 */
export const IMPLICIT_SUBMIT = 'button:not([type="button" i])';

/**
 * Every element that must never be clicked or typed into, whatever ARIA role it wears.
 *
 * `IMPLICIT_SUBMIT` covers `<button>` and nothing else, and the role-based clauses below were
 * written with only that in mind — so `<input type="submit" role="combobox">` matched
 * `[role=combobox]:not(IMPLICIT_SUBMIT)`, because an input is not a button. It was classified
 * as a combobox, and the fill path's first act on a combobox is to CLICK IT OPEN. Verified in
 * Chromium: the form submits.
 *
 * That is the one invariant this codebase is built around, broken by four separate spellings
 * at once. `type=image` submits as well. `type=reset` wipes every answer already typed.
 * `type=password` walked straight past the exclusion added for it a few commits ago, since
 * that exclusion lives on the `input` clause and this arrives through another. The same hole
 * existed on `[contenteditable=true]` and on `[role=option]`, which is clicked one level down.
 *
 * `scripts/g4-scan.ts` could not see any of it: it looks for the word "submit" and for
 * `[type=submit]` in the source, and these clicks have neither.
 *
 * So the exclusion is expressed once, here, and applied to every clause — including the ones
 * for `input`, which no longer state their own version of it. A rule written out four times
 * is a rule that will be four different rules by the end of the year.
 */
export const NEVER_TOUCH =
  ':not(button:not([type="button" i]))' +
  ':not(input[type=hidden])' +
  ':not(input[type=submit])' +
  ':not(input[type=image])' +
  ':not(input[type=reset])' +
  ':not(input[type=button])' +
  ':not(input[type=password])';

export const FILLABLE_CONTROLS =
  // Every clause carries `NEVER_TOUCH`, including the plain `input` one, which used to spell
  // its own exclusions out. See NEVER_TOUCH for what happened when only some of them did.
  `input${NEVER_TOUCH}, textarea${NEVER_TOUCH}, select${NEVER_TOUCH}, ` +
  `[role=combobox]${NEVER_TOUCH}, [contenteditable=true]${NEVER_TOUCH}`;

/**
 * The options inside an open combobox, under the same rule as the combobox itself.
 *
 * One level down and exactly as clickable, so `<input type="submit" role="option">` submitted
 * a form the moment the tool picked an answer from a dropdown.
 */
export const SAFE_OPTION = `[role=option]${NEVER_TOUCH}`;
