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

export const FILLABLE_CONTROLS =
  'input:not([type=hidden]):not([type=submit]):not([type=button])' +
  ':not([type=image]):not([type=reset]), ' +
  `textarea, select, [role=combobox]:not(${IMPLICIT_SUBMIT}), ` +
  `[contenteditable=true]:not(${IMPLICIT_SUBMIT})`;

/** The options inside an open combobox, under the same rule as the combobox itself. */
export const SAFE_OPTION = `[role=option]:not(${IMPLICIT_SUBMIT})`;
