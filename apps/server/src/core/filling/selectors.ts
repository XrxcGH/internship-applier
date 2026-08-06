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
export const FILLABLE_CONTROLS =
  'input:not([type=hidden]):not([type=submit]):not([type=button])' +
  ':not([type=image]):not([type=reset]), ' +
  'textarea, select, [role=combobox], [contenteditable=true]';
