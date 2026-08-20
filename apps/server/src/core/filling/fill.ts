/**
 * Executing a fill plan — docs/07-form-automation.md § Fill strategies.
 *
 * READ-BACK IS THE POINT. Every write is followed by a read of what the page now holds,
 * and a mismatch is reported rather than assumed away. Forms reformat phone numbers,
 * truncate at maxlength, reject a date format, silently ignore a value on a controlled
 * component, or drop it when a validation handler fires. Without read-back the tool would
 * report a clean run over a half-empty form and the user would trust it.
 *
 * WHY IT TYPES INSTEAD OF SETTING VALUES. `fill()` assigns in one shot and never produces
 * key events, and a large class of widgets — autocomplete, rich text, anything React
 * controls through onKeyDown — ignores that entirely. The fixture's /nasty page reproduces
 * it exactly. Typing is what those widgets are built to accept; it is not an evasion
 * measure and nothing here is tuned against bot detection.
 *
 * G4. There is no branch in this file that clicks a submit control, and the fixture
 * records every POST it receives so the suite can prove no form was submitted rather than
 * merely that no `.click()` was written. Not clicking submit is only half of it: typing can
 * submit a form too, because `pressSequentially` presses a real key per character and
 * Playwright's keyboard treats "\n" and "\r" as Enter, which a single-input form submits on.
 * Nothing below sends a key a form can act on — see LINE_BREAK.
 */
import type { Frame, Locator, Page } from 'playwright';
import type { FormField } from '@ia/shared';
import { logger } from '../../infra/logger';
import { keyDelay } from './browser';
import { FILLABLE_CONTROLS, SAFE_OPTION } from './selectors';
import { stillSameDocument, parseFrameKey } from './formMap';
import type { FillAction, FillPlan } from './plan';

export interface FieldResult {
  field: FormField;
  status: 'ok' | 'mismatch' | 'failed' | 'skipped';
  /** What the page held after the write. */
  readBack?: string;
  note?: string;
}

export interface FillResult {
  results: FieldResult[];
  filled: number;
  mismatched: number;
  failed: number;
  /**
   * Where the page went, if it left the document the form was read from partway through.
   *
   * `executePlan` detects this and stops, and used to keep the fact to itself — so
   * `describeFill` went on printing "Nothing has been submitted." in the one case where this
   * code knows it might not be true. A mid-fill navigation is attributed by run.ts to "a
   * select whose onchange navigates, a form that submits itself", and `selectOption`,
   * `check` and `click` all fire the page's own handlers: a form that submits itself on
   * change genuinely can have been submitted, and nothing here can tell.
   *
   * Undefined on every ordinary run, which is what keeps the plain sentence plain.
   */
  movedTo?: string;
}

/**
 * Is the browser still showing the document the form was read from?
 *
 * Origin and path only, and deliberately so — but this is NOT the real test.
 *
 * A URL cannot answer this question. `?step=2` appearing in the address bar is a new document
 * when the page did `location.href = '?step=2'` and the SAME document when it did
 * `history.pushState` — which is what an application form built as a single-page app does on
 * every step. Tightening this to include the query would stop a fill that is going fine,
 * which is the failure the original rule was written to avoid; leaving it loose lets a real
 * navigation past. Both directions are wrong because the input is insufficient.
 *
 * So the load-bearing check is `documentToken` below, stamped into the document when the form
 * is scanned and re-read after each field: a real navigation loses it, a pushState keeps it.
 * This stays as the cheap first filter — a different PATH is a different document under any
 * reading — and the token settles everything it cannot.
 */
export function sameDocument(current: string, recorded: string): boolean {
  if (current === recorded) return true;
  try {
    const a = new URL(current);
    const b = new URL(recorded);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

/**
 * Resolves the frame a field lives in, or nothing at all.
 *
 * Matching on the URL alone was wrong twice over. Frames share URLs far more often than it
 * sounds — every `srcdoc` iframe reports `about:srcdoc`, every blank one `about:blank` — so
 * a page with two essay editors sent both answers into the first one, leaving the second
 * empty and reporting both filled. And when the recorded frame had gone away, falling back
 * to the main document did not mean "fill nothing"; with an index locator it meant `.nth(N)`
 * in a completely different document, which is how an approved essay was once typed into a
 * Social Security Number box that the redline pass had deliberately left alone.
 *
 * So: the recorded position must still hold the recorded URL, or exactly one frame must
 * carry that URL and no other. Anything else is a field this tool cannot locate, and saying
 * so is the only honest outcome — read-back cannot help here, because it re-reads whatever
 * wrong element was resolved and finds the value sitting in it.
 */
function frameFor(page: Page, field: FormField, documentUrl?: string): Frame | undefined {
  if (!field.frame) {
    // The main document gets the same treatment the iframe half has always had. It was
    // exempt, and that exemption was how an approved essay reached a Social Security Number
    // box: filling a country dropdown fired the page's own `location.href` handler, the
    // browser moved to step two, and `__index__1` — a position, not an identity — resolved
    // to whatever sat second in a document the redline pass had never scanned. Read-back
    // could not help, because it re-read the wrong element and found the value in it.
    const main = page.mainFrame();
    if (documentUrl && !sameDocument(main.url(), documentUrl)) return undefined;
    return main;
  }
  const { index, url } = parseFrameKey(field.frame);
  // The position is counted over the whole list, the way the scanner numbered it.
  const all = page.frames();
  const at = all[index];
  if (at && !at.isDetached() && at.url() === url) return at;
  const sameUrl = all.filter((f) => !f.isDetached() && f.url() === url);
  return sameUrl.length === 1 ? sameUrl[0] : undefined;
}

/**
 * Index locators are a last resort from the scanner, and they are the ones most likely to
 * be stale. Resolving them here keeps that fragility in one place.
 */
function locate(frame: Frame, field: FormField): Locator {
  const m = /^__index__(\d+)(?::\d+)?$/.exec(field.locator);
  if (m) {
    return frame.locator(FILLABLE_CONTROLS).nth(Number(m[1]));
  }
  return frame.locator(field.locator);
}

/**
 * Above this many characters, keystroke pacing is dropped.
 *
 * The pacing exists so a debouncing widget — an autocomplete, a validator that fires on
 * change — has time to keep up. An essay box has nothing watching it, so at `TYPING_DELAY`
 * a 600-character answer would spend somewhere between six and eighteen seconds asleep for
 * no benefit at all. The key events fire either way, which is the part that matters.
 */
const LONG_TEXT = 120;

/** Normalizes for comparison. Forms reformat freely and that is not a failure. */
function comparable(s: string): string {
  return s.toLowerCase().replace(/[\s()\-.+]/g, '');
}

/**
 * How much of a value a form may drop and still be said to have kept it.
 *
 * A form that trims a few characters off the end has done something ordinary. A form that
 * keeps one character of a 600-character essay has thrown the answer away, and "any
 * non-empty prefix counts" reported that as filled — the precise failure read-back exists to
 * catch. The plan already slices to the form's own maxlength before typing, so a loss this
 * large is never the budget being enforced.
 */
const KEPT_ENOUGH = 0.9;

/**
 * Did the page keep what we typed?
 *
 * Deliberately lenient about formatting and strict about content. "+1 (555) 010-0000"
 * matching "15550100000" is the form being helpful; an empty box is not, and neither is a
 * box holding a tenth of the answer.
 */
function accepted(intended: string, actual: string): boolean {
  if (actual === intended) return true;
  const a = comparable(actual);
  const b = comparable(intended);
  if (!a) return false;
  if (a === b) return true;
  // A prefix, and nearly all of one. The other direction — the page holding MORE than was
  // typed — used to count as well, which is how a second fill run that appended an approved
  // answer to itself came back "ok" with the answer in the box twice.
  return b.startsWith(a) && a.length >= b.length * KEPT_ENOUGH;
}

/**
 * Line breaks, in every shape a real answer arrives in.
 *
 * THE RULE: nothing this tool types may be a character the browser will act on as a key.
 * `pressSequentially` presses one key per character, and Playwright's US layout aliases both
 * "\n" and "\r" to Enter — so "\r\n" is two Enter presses. In a form whose only text box is
 * a single-line <input>, one Enter is the browser's implicit submit: an ordinary
 * two-paragraph answer, approved by the user but not yet read on the page, sent the
 * application to the employer, and the run reported the field as a mismatch and the rest as
 * timeouts, which reads like a flaky page rather than a submitted application.
 *
 * Enter is the only character in that layout today; Tab and the other control characters
 * arrive as plain text. So a break is dropped to a space where the control cannot hold one,
 * and where it can, it is inserted with `insertText`, which fires no key events at all. If a
 * future Playwright maps another character to a key, it belongs here too.
 */
const LINE_BREAK = /\r\n?|\n/;

/** Controls that can hold more than one line, so a break belongs in the value. */
function holdsLineBreaks(control: FormField['control']): boolean {
  return control === 'textarea' || control === 'richtext';
}

/** The words of a label, so "No, not now or in the future" starts with the word "no". */
function wordsOf(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Does this label begin with the intended answer, as whole words rather than letters? */
function beginsWith(label: string, value: string): boolean {
  const l = wordsOf(label);
  const v = wordsOf(value);
  if (v.length === 0 || l.length < v.length) return false;
  return v.every((w, i) => l[i] === w);
}

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * Which option a value means — docs/07-form-automation.md § Filling.
 *
 * Order matters here more than anywhere else in this file. Matching a prose label by
 * substring before trying the option's own value is how "US" selected Australia (the label
 * "Australia" contains "us"), "WA" selected Delaware, and "VA" selected Nevada — twenty-one
 * of the fifty state codes and eighteen of fifty-one country codes went to the wrong entry.
 * Worse, it is how "No" selected "Yes, now or in the future", because that phrase contains
 * the letters of "no": a candidate who needs no sponsorship was recorded as needing it, and
 * one not authorized to work was recorded as authorized, on the two questions that decide an
 * application on their own.
 *
 * So the value attribute is tried first, then the whole label, and only then prose — and the
 * prose pass matches whole leading WORDS, never letters, and refuses when two options fit.
 * An option carrying an empty value is the "Select an option" placeholder; choosing it does
 * not fill a field, it blanks one. When nothing clears the bar the field is left for the
 * user, which is a far better outcome than a confident wrong answer under their name.
 *
 * EVERY option list goes through here — `<select>`, radio groups, and div comboboxes alike.
 * Each of the other two kept a matcher of its own after this one was hardened, and each of
 * them went on making this exact mistake on the sponsorship question. One list, one rule.
 */
export function chooseOption<T extends SelectOption>(options: T[], value: string): T | undefined {
  const real = options.filter((o) => o.value.trim() !== '');
  const byValue = real.find((o) => comparable(o.value) === comparable(value));
  if (byValue) return byValue;
  const byLabel = real.find((o) => comparable(o.label) === comparable(value));
  if (byLabel) return byLabel;
  // A one-character answer carries too little to identify an option by its opening word.
  if (comparable(value).length < 2) return undefined;
  const leading = real.filter((o) => beginsWith(o.label, value));
  return leading.length === 1 ? leading[0] : undefined;
}

async function readValue(loc: Locator, field: FormField): Promise<string> {
  try {
    if (field.control === 'checkbox' || field.control === 'radio') {
      return (await loc.isChecked()) ? 'checked' : '';
    }
    if (field.control === 'combobox' || field.control === 'richtext') {
      /**
       * The sources a real widget actually keeps its value in, in that order.
       *
       * `controlOf` calls anything carrying `role="combobox"` a combobox before it looks at
       * the tag — which is right, and means `<input role="combobox">` lands here. That is the
       * shape ARIA 1.2 prescribes and the one every major component library ships. Reading
       * `innerText()` off an input returns the empty string, because an input has no text
       * content: its value lives in `.value`. So read-back compared "" against what had just
       * been typed and reported a MISMATCH on every one of them — a filled field flagged for
       * the user to go and check, on the commonest dropdown shape on the web.
       */
      const declared = await loc.getAttribute('data-value');
      if (declared !== null) return declared.trim();

      // `inputValue()` throws on an element that is not a form control, which is exactly how
      // a div-based combobox is told apart from an input-based one.
      try {
        const value = await loc.inputValue();
        if (value.trim() !== '') return value.trim();
      } catch {
        // Not an input. Its text is its value.
      }
      return (await loc.innerText()).trim();
    }
    return await loc.inputValue();
  } catch {
    return '';
  }
}

async function fillOne(page: Page, action: FillAction, documentUrl?: string): Promise<FieldResult> {
  const { field, value } = action;
  const frame = frameFor(page, field, documentUrl);
  if (!frame) {
    const moved = !field.frame;
    return {
      field,
      status: 'failed',
      note: moved
        ? 'The page moved to a different address after this form was read, so nothing was ' +
          'typed here. Open the form again.'
        : 'The part of the page this field lives in is no longer there. Fill it in yourself.',
    };
  }
  const loc = locate(frame, field);

  /**
   * What the read-back should say, which is not always what we set.
   *
   * A ticked checkbox reads back as "checked", never as "Yes"; a select reads back its
   * option's VALUE attribute, which on most real ATS forms is a code rather than the
   * prose we matched on. Comparing either against the plan's value reported a mismatch
   * on every field the tool got right — and a verification step that cries wolf is how
   * you teach someone to click past the one that matters.
   */
  let expected = value;

  /**
   * What the report prints when the page kept the value, when that is not the read-back.
   *
   * A ticked checkbox reads back "checked", and nobody needs telling that; they need telling
   * what it was ticked for.
   */
  let reported: string | undefined;

  /** Anything the user should know about a value that was adjusted before it was typed. */
  let adjusted: string | undefined;

  try {
    await loc.waitFor({ state: 'visible', timeout: 5000 });

    /**
     * Nothing here re-checks that the element cannot submit, and that is deliberate.
     *
     * Three branches below open with `loc.click()`, so the question is real — but every
     * locator this function can hold comes from `FILLABLE_CONTROLS` or `SAFE_OPTION`
     * (selectors.ts), and both now exclude a button that is not explicitly `type="button"`.
     * That includes the index fallback in `locate`, which resolves `nth(N)` against
     * FILLABLE_CONTROLS itself — so however far a re-rendered page shifts the indices, the
     * element it lands on is drawn from a set with no submit control in it.
     *
     * A second check here would have to ask the page, and a per-field `evaluate` is a round
     * trip on every field to re-derive what the selector already guarantees. What keeps this
     * honest instead is `selectors.test.ts`, which asks Chromium's own engine what those two
     * selectors match — a test that reads the selector string could not tell a working
     * `:not()` from one the browser silently failed to parse.
     */
    switch (field.control) {
      case 'file': {
        if (!action.filePath) {
          return { field, status: 'skipped', note: 'No file to attach.' };
        }
        await loc.setInputFiles(action.filePath);
        const names = await loc.evaluate((el: unknown) => {
          const input = el as {
            files?: { length: number; item(i: number): { name: string } | null };
          };
          const out: string[] = [];
          for (let i = 0; i < (input.files?.length ?? 0); i++) {
            const f = input.files?.item(i);
            if (f) out.push(f.name);
          }
          return out.join(', ');
        });
        return names
          ? { field, status: 'ok', readBack: names }
          : { field, status: 'mismatch', note: 'The page did not accept the file.' };
      }

      case 'select':
      case 'multiselect': {
        const options = field.options ?? [];
        const wanted = chooseOption(options, value);
        if (!wanted) {
          return {
            field,
            status: 'skipped',
            note: `No option matching "${value}". Choose it yourself.`,
          };
        }
        await loc.selectOption(wanted.value);

        /**
         * Report the prose the page now displays, not the value that was asked for.
         *
         * A select reads back its option's VALUE attribute, which on real ATS forms is a
         * code rather than the words next to it, so the report used to substitute the
         * planned value whenever the two differed. That made the one field a reader most
         * needs to check look like the one they can trust: the page said "Australia" and
         * the report said "US", with a green tick beside it. Resolving the page's value
         * back through the option list and printing THAT means a wrong choice is visible
         * to the person reviewing the form, which is the only thing that can catch it —
         * re-reading a select cannot tell a bad match apart from a good one, because the
         * page simply holds whatever it was told.
         */
        const held = await readValue(loc, field);
        const shown = options.find((o) => o.value === held)?.label ?? held;
        if (held.trim() === wanted.value.trim()) {
          return { field, status: 'ok', readBack: shown };
        }
        return {
          field,
          status: 'mismatch',
          readBack: shown,
          note: shown
            ? `The page shows "${shown}" instead. Check this one.`
            : 'The page did not keep this value. Fill it in yourself.',
        };
      }

      case 'radio': {
        // A grouped radio is a question with options, and the choice is made by matching
        // the intended value against each button's OWN text — never by ticking whichever
        // button happened to carry the group's question as its label.
        //
        // Matched by the same rule as a dropdown, because an option list is an option list
        // wherever it is drawn. Letter-level prefix matching lived here after it had been
        // taken out of `chooseOption`, and it did the same damage one control down: "Yes"
        // ticked "Yes, but I will require sponsorship now or in the future" and "Currently
        // enrolled" ticked "Currently enrolled part-time", each by document order, each
        // reported ok. Whatever `chooseOption` learns next, radios learn with it.
        const options = field.options ?? [];
        if (options.length > 0) {
          const chosen = chooseOption(options, value);
          if (!chosen?.locator) {
            return {
              field,
              status: 'skipped',
              note: `No option matching "${value}". Choose it yourself.`,
            };
          }
          const target = locate(frame, { ...field, locator: chosen.locator });
          await target.check();
          return (await target.isChecked())
            ? { field, status: 'ok', readBack: chosen.label }
            : { field, status: 'mismatch', note: 'The page did not keep this choice.' };
        }

        // An ungrouped stray: no options, so there is nothing to choose between.
        if (/^(yes|true|on|checked)$/i.test(value)) await loc.check();
        else return { field, status: 'skipped', note: 'Left for you to decide.' };
        expected = 'checked';
        reported = value;
        break;
      }

      case 'checkbox': {
        // Only ever ticks, never unticks, and only for an affirmative value. A checkbox
        // this tool does not understand is left exactly as the page had it.
        if (/^(yes|true|on|checked)$/i.test(value)) await loc.check();
        else return { field, status: 'skipped', note: 'Left for you to decide.' };
        expected = 'checked';
        reported = value;
        break;
      }

      case 'combobox': {
        // A div-based combobox has no value to set: it has to be opened and an option
        // clicked, the same way a person would.
        await loc.click();

        /**
         * The options are read first and chosen between in memory, by the same rule as a
         * dropdown — never by asking the page for the first option whose text contains the
         * value. That substring search picked "Yes, now or in the future" for "No" (the word
         * "now" carries the letters), "Australia" for "US" and "Nevada" for "VA", and it had
         * already clicked the wrong one by the time read-back could object. The listbox this
         * combobox owns is preferred over the whole frame because an ATS that renders every
         * question's options into one document will otherwise offer up an option belonging to
         * a different question entirely.
         */
        const owns =
          (await loc.getAttribute('aria-controls')) ?? (await loc.getAttribute('aria-owns'));
        const listbox = owns ? frame.locator(`[id="${owns.replace(/["\\]/g, '\\$&')}"]`) : null;
        /**
         * Never the whole frame. A widget that declares nothing is scoped to what contains it.
         *
         * The fallback here was `frame`, so a hand-rolled ATS dropdown — the exact shape
         * `IMPLICIT_SUBMIT` exists for — had `chooseOption` pick the FIRST matching option
         * anywhere in the document. Yes/no options are duplicated across every yes/no question
         * on an application form, so "Yes" for "are you authorized to work" and "Yes" for "do
         * you require sponsorship" are indistinguishable by value or label: the answer to one
         * question could be clicked in another, and the read-back would then compare the right
         * value against the right box and call it filled.
         *
         * The scope is the NEAREST ancestor that actually contains options — not a fixed number
         * of levels up, which is a guess about markup nobody controls, and not the form, which
         * is the frame again under another name. A widget's own listbox is by construction the
         * closest one enclosing both it and its options; a neighbouring question's is further
         * out, past the first ancestor that qualifies.
         */
        const nearby = loc.locator("xpath=ancestor::*[.//*[@role='option']][1]");
        const scope =
          listbox && (await listbox.count()) > 0
            ? listbox
            : (await nearby.count()) > 0
              ? nearby
              : frame;
        const optionLoc = scope.locator(SAFE_OPTION);
        const offered = await optionLoc.evaluateAll((els) =>
          els.map((el) => ({
            value:
              el.getAttribute('data-value') ??
              el.getAttribute('value') ??
              (el.textContent ?? '').trim(),
            label: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim(),
          })),
        );
        if (offered.length === 0) {
          return { field, status: 'skipped', note: 'This dropdown offered no options to pick.' };
        }
        const picked = chooseOption(
          offered.map((o, index) => ({ ...o, index })),
          value,
        );
        if (!picked) {
          return {
            field,
            status: 'skipped',
            note: `No option matching "${value}". Choose it yourself.`,
          };
        }
        await optionLoc.nth(picked.index).click();

        // Like a select, this cannot be verified by re-reading — the widget holds whatever it
        // was told — so the report prints the words the page now shows.
        const now = await readValue(loc, field);
        const held = comparable(now);
        if (held === comparable(picked.value) || held === comparable(picked.label)) {
          return { field, status: 'ok', readBack: picked.label };
        }
        return {
          field,
          status: 'mismatch',
          readBack: now,
          note: now
            ? `The page shows "${now}" instead. Check this one.`
            : 'The page did not keep this value. Fill it in yourself.',
        };
      }

      case 'richtext': {
        await loc.click();
        // Clear anything already in the box, exactly as the typing branch does. Without it a
        // second run on a contenteditable essay inserted the approved answer after the copy
        // already sitting there, leaving the employer's form holding it twice — and read-back
        // called that ok, because the box did contain what we typed.
        await loc.fill('');
        // `insertText` fires no key events, so a line break here cannot press Enter.
        await page.keyboard.insertText(value);
        break;
      }

      case 'date': {
        // A date input holds a structured value, not text. Typing into one produces
        // whatever the browser's segmented editor makes of the keystrokes, which for an
        // ISO string is nothing. `fill()` is the only thing that sets it correctly.
        //
        // And the two granularities are not interchangeable. A graduation is stored as a
        // month ("2027-05") and an availability as a full day ("2027-06-01"), while the
        // scanner reports <input type=date> and <input type=month> as the same kind of
        // control — so whichever the employer used, one of them was handed a value the input
        // cannot hold. Playwright throws "Malformed value" at that, and those two words were
        // what the user was shown next to their graduation date, on every form that asked
        // for one, forever.
        const kind = await loc
          .evaluate((el: unknown) => String((el as { type?: string }).type ?? '').toLowerCase())
          .catch(() => '');
        let iso = value;
        if (kind === 'date' && /^\d{4}-\d{2}$/.test(iso)) {
          iso = `${iso}-01`;
          adjusted =
            'Your profile records only the month, so the first of it was used. ' +
            'Change the day if this form needs an exact date.';
        } else if (kind === 'month' && /^\d{4}-\d{2}-\d{2}$/.test(iso)) {
          iso = iso.slice(0, 7);
        }
        await loc.fill(iso);
        expected = iso;
        break;
      }

      default: {
        await loc.click();
        // Clear anything prefilled, or values concatenate.
        await loc.fill('');

        // A line break is never pressed. See LINE_BREAK: Enter is a key, and in a
        // single-input form it is the submit button.
        const lines = value.split(LINE_BREAK);
        const multiline = holdsLineBreaks(field.control);
        expected = lines.join(multiline ? '\n' : ' ');
        if (!multiline && lines.length > 1) {
          adjusted = 'This box holds one line, so the breaks in your answer became spaces.';
        }
        // Real key events, because that is what widgets listen for. The DELAY between
        // them is not what makes them work, so anything past LONG_TEXT gets none.
        const delay = value.length > LONG_TEXT ? 0 : keyDelay();
        for (const [i, line] of lines.entries()) {
          if (i > 0) {
            if (multiline) await page.keyboard.insertText('\n');
            else await loc.pressSequentially(' ', { delay, timeout: 60_000 });
          }
          if (line) await loc.pressSequentially(line, { delay, timeout: 60_000 });
        }
      }
    }

    const readBack = await readValue(loc, field);
    if (accepted(expected, readBack)) {
      // The report shows what a person would see on the page, not the option code we
      // compared against.
      return { field, status: 'ok', readBack: reported ?? readBack, note: adjusted };
    }

    return {
      field,
      status: 'mismatch',
      readBack,
      note: readBack
        ? `The page shows "${readBack}" instead. Check this one.`
        : 'The page did not keep this value. Fill it in yourself.',
    };
  } catch (err) {
    return {
      field,
      status: 'failed',
      note: err instanceof Error ? err.message.split('\n')[0] : String(err),
    };
  }
}

export interface ExecuteOptions {
  onProgress?: (r: FieldResult) => void;
  /**
   * The address the FormMap was read from, so a fill that outlives its own page can stop.
   *
   * Without it every locator is resolved against whatever the browser happens to be showing.
   * A country dropdown with an `onchange` that sets `location.href` — an everyday pattern —
   * is enough: the page moved to step two, and the rest of the plan carried on typing into a
   * document nobody had scanned and the redline pass had never seen.
   */
  documentUrl?: string;
  /** The mark left at scan time. See `stillSameDocument`. */
  documentToken?: string;
}

/**
 * Runs the plan.
 *
 * Sequential rather than parallel, because forms run validation and conditional logic on
 * every change and a field that appears only after another is answered has to be filled
 * in order. It is also what makes the visible browser watchable.
 */
export async function executePlan(
  page: Page,
  plan: FillPlan,
  opts: ExecuteOptions = {},
): Promise<FillResult> {
  const { onProgress, documentUrl, documentToken } = opts;
  const results: FieldResult[] = [];
  let movedTo: string | undefined;

  for (const action of plan.actions) {
    if (movedTo) {
      // Stopping is the point. A page that navigated mid-plan invalidates every locator left
      // in it, and an index locator does not fail when that happens — it resolves to
      // whatever now sits at that position and reports it filled.
      const r: FieldResult = {
        field: action.field,
        status: 'failed',
        note: 'The page moved to a different address partway through, so nothing was typed here.',
      };
      results.push(r);
      onProgress?.(r);
      continue;
    }

    const r = await fillOne(page, action, documentUrl);
    results.push(r);
    onProgress?.(r);
    if (r.status !== 'ok') {
      logger.warn({ label: r.field.label, status: r.status, note: r.note }, 'field not filled');
    }

    const now = page.mainFrame().url();
    if (documentUrl && !sameDocument(now, documentUrl)) {
      movedTo = now;
      logger.warn({ from: documentUrl, to: now }, 'page moved to a different address; stopping');
    } else if (!(await stillSameDocument(page, documentToken))) {
      // The address can be identical and the document new — a form that posts to itself, a
      // reload. The URL check above cannot see either, and every locator left in the plan,
      // index locators above all, describes a DOM that has been rebuilt.
      movedTo = now;
      logger.warn({ at: now }, 'the document was replaced without the address changing; stopping');
    }
  }

  for (const skip of plan.skips) {
    const r: FieldResult = { field: skip.field, status: 'skipped', note: skip.note };
    results.push(r);
    onProgress?.(r);
  }

  return {
    results,
    filled: results.filter((r) => r.status === 'ok').length,
    mismatched: results.filter((r) => r.status === 'mismatch').length,
    failed: results.filter((r) => r.status === 'failed').length,
    // Carried out rather than left behind: the summary cannot promise nothing was submitted
    // if it does not know the page navigated. See `movedTo` on FillResult.
    ...(movedTo === undefined ? {} : { movedTo }),
  };
}

/**
 * What the user is told when the run finishes.
 *
 * Leads with what still needs them. A summary that opened with "18 fields filled" would
 * read as done, and the whole point of stopping before submit is that it is not.
 */
export function describeFill(result: FillResult): string {
  if (result.results.length === 0) {
    // A run that found nothing is not a successful run. "All 0 fields filled. Read the page,
    // then submit it yourself." is what the user was told when the form had not rendered yet
    // — a career-site SPA, or a page behind an "Apply now" step — and it sent them to submit
    // a form this tool had never typed a character into, under a green tick.
    return (
      'Nothing on this page could be read as a form field, so nothing was typed. ' +
      'Check the page in the browser window.'
    );
  }
  const needsYou = result.results.filter((r) => r.status !== 'ok').length;
  if (needsYou === 0) {
    const n = result.filled;
    return `All ${n} field${n === 1 ? '' : 's'} filled. Read the page, then submit it yourself.`;
  }
  const tail =
    result.movedTo === undefined
      ? 'Nothing has been submitted.'
      : // The page left the document the form was read from, which is the one case where the
        // sentence above would be a claim rather than a fact. Say what happened and what this
        // tool did NOT do, which is all it can honestly say.
        `The page moved to ${result.movedTo} partway through, so the rest was not typed. This ` +
        'tool did not submit anything — but a page can submit itself, so check there before ' +
        'filling this again.';
  return (
    `${needsYou} field${needsYou === 1 ? '' : 's'} still need${needsYou === 1 ? 's' : ''} you. ` +
    `${result.filled} filled. ${tail}`
  );
}
