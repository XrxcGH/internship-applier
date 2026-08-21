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

/**
 * An ARIA role must not smuggle a submit button past the exclusions.
 *
 * `IMPLICIT_SUBMIT` covers `<button>` and nothing else, and the role clauses were written
 * with only that in mind — so `<input type="submit" role="combobox">` matched
 * `[role=combobox]:not(IMPLICIT_SUBMIT)`, because an input is not a button. It was classified
 * as a combobox, and the fill path's first act on a combobox is to CLICK IT OPEN. Confirmed
 * in Chromium before the fix: the form submitted. That is the one invariant this codebase is
 * built around, and it was broken by four spellings at once — `type=image` submits too,
 * `type=reset` wipes every answer already typed, and `type=password` walked straight past the
 * exclusion added for it, which lives on a clause this arrives through another way.
 *
 * `scripts/g4-scan.ts` cannot see any of this: it looks for the word "submit" and for
 * `[type=submit]` in the source, and these clicks have neither. Which is why the property is
 * asserted here, against a real browser, rather than left to the scan.
 */
describe('what an ARIA role must not smuggle through', () => {
  // Its own page: the cases above share one document set up in `beforeAll`, and replacing its
  // content from here would leave whichever test ran next looking at the wrong DOM.
  let trapPage: Page;

  beforeAll(async () => {
    trapPage = await browser.newPage();
    await trapPage.setContent(TRAPS);
  }, 60_000);

  afterAll(async () => {
    await trapPage?.close();
  });

  const inTraps = async (selector: string): Promise<string[]> =>
    trapPage.evaluate((sel) => [...document.querySelectorAll(sel)].map((el) => el.id), selector);

  const TRAPS = `<form id="f" action="/submitted" method="POST">
    <input id="combo-submit" type="submit" role="combobox" aria-label="Email">
    <input id="combo-image" type="image" role="combobox" aria-label="Phone">
    <input id="combo-reset" type="reset" role="combobox" aria-label="City">
    <input id="combo-pw" type="password" role="combobox" aria-label="Question">
    <input id="ce-submit" type="submit" contenteditable="true" aria-label="Essay">
    <input id="opt-submit" type="submit" role="option" value="Yes">
    <button id="btn-combo" role="combobox">Pick</button>

    <!-- The same bug one level down: the wrapper is excluded by nothing, and a click lands on
         whatever is under the cursor rather than on the element that was located. Playwright's
         actionability check accepts a hit target that is a descendant, so the click reached
         the child and posted the application. Both shapes verified submitting in Chromium. -->
    <div id="wrap-submit" role="combobox" aria-label="Email"
         style="position:relative;width:240px;height:34px">
      <input type="submit" value="Email"
             style="position:absolute;left:0;top:0;width:100%;height:100%">
    </div>
    <div id="wrap-button" role="combobox" aria-label="Country"><button>Go</button></div>
    <div id="wrap-pw" role="combobox" aria-label="Secret"><input type="password"></div>
    <!-- The other two things a wrapper can hold. type=image is a graphical submit button and
         type=reset wipes every answer already typed; both had a :has() clause and neither had
         a trap, so two of the five clauses were pinned by nothing at all. -->
    <div id="wrap-image" role="combobox" aria-label="Photo"><input type="image" src="x.png"></div>
    <div id="wrap-reset" role="combobox" aria-label="Start over"><input type="reset"></div>
    <div id="wrap-opt" role="option"><input type="submit" value="Yes"></div>

    <!-- A label forwards activation to its control wherever the click lands, and with a for= attribute
         that control need not be inside it — which no :has() selector can see. -->
    <label id="label-wrap" role="combobox" aria-label="Phone"><input type="submit" value="P"></label>
    <label id="label-for" role="combobox" for="far-submit" aria-label="City">City</label>
    <input id="far-submit" type="submit" value="go">

    <input id="ok-text" type="text" aria-label="Name">
    <textarea id="ok-area" aria-label="Why"></textarea>
    <select id="ok-select"><option>a</option></select>
    <div id="ok-combo" role="combobox" tabindex="0"></div>
    <div id="ok-ce" contenteditable="true">type here</div>
    <div id="ok-opt" role="option">Choice A</div>
  </form>`;

  it('matches no submit-capable control, whatever role it wears', async () => {
    const matched = await inTraps(FILLABLE_CONTROLS);
    for (const trap of [
      'combo-submit',
      'combo-image',
      'combo-reset',
      'combo-pw',
      'ce-submit',
      'btn-combo',
    ]) {
      expect(matched, trap).not.toContain(trap);
    }
  });

  it('matches nothing that merely CONTAINS a control that can submit', async () => {
    // A click lands on whatever is under the cursor, not on the element that was located, and
    // Playwright's actionability check is satisfied by a descendant hit target. Every one of
    // these passed the element-only exclusions and posted the application on the first click.
    const matched = await inTraps(FILLABLE_CONTROLS);
    for (const trap of [
      'wrap-submit',
      'wrap-button',
      'wrap-image',
      'wrap-reset',
      'wrap-pw',
      'label-wrap',
      'label-for',
    ]) {
      expect(matched, trap).not.toContain(trap);
    }
    expect(await inTraps(SAFE_OPTION)).not.toContain('wrap-opt');
  });

  it('refuses a label whatever it points at, because `for` reaches outside the subtree', async () => {
    // `label-for` contains nothing at all — its submit button is a sibling. No `:has()` can
    // see that, so labels are excluded outright rather than by what they happen to wrap.
    const { NEVER_TOUCH } = await import('../src/core/filling/selectors');
    expect(NEVER_TOUCH).toContain(':not(label)');
    expect(await inTraps(FILLABLE_CONTROLS)).not.toContain('label-for');
  });

  it('matches no submit-capable option either, one level down', async () => {
    // Options are clicked when an answer is picked from a dropdown, so the same rule applies.
    expect(await inTraps(SAFE_OPTION)).not.toContain('opt-submit');
  });

  it('still matches the controls a form actually needs filled', async () => {
    // The other direction, and the one that matters if the exclusion is written too widely:
    // an ordinary text box and a div-based combobox must stay reachable.
    const matched = await inTraps(FILLABLE_CONTROLS);
    for (const ok of ['ok-text', 'ok-area', 'ok-select', 'ok-combo', 'ok-ce']) {
      expect(matched, ok).toContain(ok);
    }
    expect(await inTraps(SAFE_OPTION)).toContain('ok-opt');
  });

  it('states the exclusion once, so four clauses cannot drift into four rules', async () => {
    const { NEVER_TOUCH } = await import('../src/core/filling/selectors');
    for (const t of ['submit', 'image', 'reset', 'password', 'hidden']) {
      expect(NEVER_TOUCH, t).toContain(`input[type=${t}]`);
    }
    // And every clause of both selectors carries it.
    expect(FILLABLE_CONTROLS.split(NEVER_TOUCH).length - 1).toBe(5);
    expect(SAFE_OPTION).toContain(NEVER_TOUCH);
  });
});
