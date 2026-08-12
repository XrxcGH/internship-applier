import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FILLABLE_CONTROLS, SAFE_OPTION } from '../src/core/filling/selectors';

/**
 * The one invariant this whole codebase is built around, asked of a real browser engine.
 *
 * `FILLABLE_CONTROLS` decides what the fill path is allowed to resolve, and three branches
 * of `fillOne` open by CLICKING what they resolved. It carefully excluded `input[type=image]`
 * and `input[type=reset]` — its docstring calls the exclusions a G4 concern — and then matched
 * `[role=combobox]` unconstrained, which catches `<button role="combobox">`. A `<button>` with
 * no `type` attribute IS `type="submit"`: the HTML default, not a quirk. So an ordinary
 * hand-rolled ATS dropdown, missing `type="button"`, was a control this tool would click, on a
 * half-filled application, inside the user's own browser session.
 *
 * `scripts/g4-scan.ts` could not see it — it looks for the word "submit" and for
 * `[type=submit]`, and that click had neither — which is exactly why this is asserted against
 * Chromium's own selector engine rather than by reading the string. The selector uses a
 * complex `:not()`, which is Selectors Level 4; a test that only checked the text of it would
 * pass just as happily if the browser silently refused to parse the thing.
 */

const HTML = `<form>
  <input id="text" name="a">
  <textarea id="essay"></textarea>
  <select id="select"><option>x</option></select>
  <div id="div-combo" role="combobox">Country</div>
  <button id="btn-combo-safe" type="button" role="combobox">Country</button>
  <button id="btn-combo-implicit" role="combobox">Country</button>
  <button id="btn-combo-submit" type="submit" role="combobox">Country</button>
  <button id="btn-combo-caps" TYPE="BUTTON" role="combobox">Country</button>
  <button id="btn-combo-reset" type="reset" role="combobox">Country</button>
  <div id="opt-div" role="option">Canada</div>
  <button id="opt-btn-safe" type="button" role="option">Canada</button>
  <button id="opt-btn-implicit" role="option">Canada</button>
  <div id="ce" contenteditable="true">essay</div>
  <button id="ce-btn" contenteditable="true">essay</button>
  <input id="submit" type="submit">
  <input id="image" type="image">
  <input id="reset" type="reset">
  <input id="hidden" type="hidden">
</form>`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.setContent(HTML);
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

const matched = async (selector: string): Promise<string[]> =>
  page.evaluate((s) => [...document.querySelectorAll(s)].map((el) => el.id), selector);

describe('FILLABLE_CONTROLS', () => {
  it('never matches a button that would submit the form', async () => {
    const ids = await matched(FILLABLE_CONTROLS);
    // The three shapes of "this click sends the form": no type at all, type=submit, and the
    // contenteditable button nobody expects to exist until it does.
    expect(ids).not.toContain('btn-combo-implicit');
    expect(ids).not.toContain('btn-combo-submit');
    expect(ids).not.toContain('ce-btn');
    // And the two the docstring was already about.
    expect(ids).not.toContain('submit');
    expect(ids).not.toContain('image');
  });

  it('never matches a button that would wipe the form', async () => {
    const ids = await matched(FILLABLE_CONTROLS);
    expect(ids).not.toContain('btn-combo-reset');
    expect(ids).not.toContain('reset');
  });

  it('still matches every control a form actually asks a person to fill', async () => {
    // The other direction, which matters just as much: over-excluding would silently stop
    // filling real fields, and the user would only find out by reading the skipped list.
    const ids = await matched(FILLABLE_CONTROLS);
    for (const id of ['text', 'essay', 'select', 'div-combo', 'ce']) {
      expect(ids, id).toContain(id);
    }
  });

  it('keeps a button-based combobox that declares itself safe, in any case', async () => {
    // `<button type="button" role="combobox">` is how a well-built widget is written — its
    // own dropdown would submit the form otherwise — so refusing those would cost real
    // coverage on real ATS forms. The attribute is matched case-insensitively.
    const ids = await matched(FILLABLE_CONTROLS);
    expect(ids).toContain('btn-combo-safe');
    expect(ids).toContain('btn-combo-caps');
  });

  it('leaves hidden inputs alone', async () => {
    expect(await matched(FILLABLE_CONTROLS)).not.toContain('hidden');
  });
});

describe('SAFE_OPTION', () => {
  it('applies the same rule one level down, inside an open dropdown', async () => {
    // `optionLoc.nth(...).click()` is the second click in the combobox branch, and it had
    // the identical hole.
    const ids = await matched(SAFE_OPTION);
    expect(ids).toContain('opt-div');
    expect(ids).toContain('opt-btn-safe');
    expect(ids).not.toContain('opt-btn-implicit');
  });
});
