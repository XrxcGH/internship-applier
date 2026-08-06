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
 * merely that no `.click()` was written.
 */
import type { Frame, Locator, Page } from 'playwright';
import type { FormField } from '@ia/shared';
import { logger } from '../../infra/logger';
import { keyDelay } from './browser';
import { FILLABLE_CONTROLS } from './selectors';
import { parseFrameKey } from './formMap';
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
function frameFor(page: Page, field: FormField): Frame | undefined {
  if (!field.frame) return page.mainFrame();
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
 * Did the page keep what we typed?
 *
 * Deliberately lenient about formatting and strict about content. "+1 (555) 010-0000"
 * matching "15550100000" is the form being helpful; an empty box is not.
 */
function accepted(intended: string, actual: string): boolean {
  if (actual === intended) return true;
  const a = comparable(actual);
  const b = comparable(intended);
  if (!a) return false;
  // Truncation at maxlength is the form's decision, and it kept a prefix of the truth.
  return a === b || b.startsWith(a) || a.startsWith(b);
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
      return ((await loc.getAttribute('data-value')) ?? (await loc.innerText())).trim();
    }
    return await loc.inputValue();
  } catch {
    return '';
  }
}

/** Turns a value into a literal for RegExp, so "C++" is a string and not a syntax error. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function fillOne(page: Page, action: FillAction): Promise<FieldResult> {
  const { field, value } = action;
  const frame = frameFor(page, field);
  if (!frame) {
    return {
      field,
      status: 'failed',
      note: 'The part of the page this field lives in is no longer there. Fill it in yourself.',
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

  try {
    await loc.waitFor({ state: 'visible', timeout: 5000 });

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
        const options = field.options ?? [];
        if (options.length > 0) {
          const chosen =
            options.find((o) => comparable(o.label) === comparable(value)) ??
            options.find((o) => comparable(o.value) === comparable(value)) ??
            options.find((o) => comparable(o.label).startsWith(comparable(value)));
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
        break;
      }

      case 'checkbox': {
        // Only ever ticks, never unticks, and only for an affirmative value. A checkbox
        // this tool does not understand is left exactly as the page had it.
        if (/^(yes|true|on|checked)$/i.test(value)) await loc.check();
        else return { field, status: 'skipped', note: 'Left for you to decide.' };
        expected = 'checked';
        break;
      }

      case 'combobox': {
        // A div-based combobox has no value to set: it has to be opened and an option
        // clicked, the same way a person would.
        await loc.click();
        // The value is a person's data, not a pattern. Unescaped, "C++" threw
        // "Nothing to repeat" and "Washington (State)" quietly matched nothing.
        const option = frame
          .locator('[role=option]')
          .filter({ hasText: new RegExp(escapeRegExp(value.slice(0, 24)), 'i') })
          .first();
        if ((await option.count()) === 0) {
          return { field, status: 'skipped', note: `No option matching "${value}".` };
        }
        await option.click();
        break;
      }

      case 'richtext': {
        await loc.click();
        await page.keyboard.insertText(value);
        break;
      }

      case 'date': {
        // A date input holds a structured value, not text. Typing into one produces
        // whatever the browser's segmented editor makes of the keystrokes, which for an
        // ISO string is nothing. `fill()` is the only thing that sets it correctly.
        await loc.fill(value);
        break;
      }

      default: {
        await loc.click();
        // Clear anything prefilled, or values concatenate.
        await loc.fill('');
        // Real key events, because that is what widgets listen for. The DELAY between
        // them is not what makes them work, so anything past LONG_TEXT gets none.
        await loc.pressSequentially(value, {
          delay: value.length > LONG_TEXT ? 0 : keyDelay(),
          timeout: 60_000,
        });
      }
    }

    const readBack = await readValue(loc, field);
    if (accepted(expected, readBack)) {
      // The report shows what a person would see on the page, not the option code we
      // compared against.
      return { field, status: 'ok', readBack: expected === value ? readBack : value };
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
  onProgress?: (r: FieldResult) => void,
): Promise<FillResult> {
  const results: FieldResult[] = [];

  for (const action of plan.actions) {
    const r = await fillOne(page, action);
    results.push(r);
    onProgress?.(r);
    if (r.status !== 'ok') {
      logger.warn({ label: r.field.label, status: r.status, note: r.note }, 'field not filled');
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
  };
}

/**
 * What the user is told when the run finishes.
 *
 * Leads with what still needs them. A summary that opened with "18 fields filled" would
 * read as done, and the whole point of stopping before submit is that it is not.
 */
export function describeFill(result: FillResult): string {
  const needsYou = result.results.filter((r) => r.status !== 'ok').length;
  if (needsYou === 0) {
    return `All ${result.filled} fields filled. Read the page, then submit it yourself.`;
  }
  return (
    `${needsYou} field${needsYou === 1 ? '' : 's'} still need${needsYou === 1 ? 's' : ''} you. ` +
    `${result.filled} filled. Nothing has been submitted.`
  );
}
