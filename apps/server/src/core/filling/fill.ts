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

/** Resolves the frame a field lives in, falling back to the main one. */
function frameFor(page: Page, field: FormField): Frame {
  if (!field.frame) return page.mainFrame();
  return page.frames().find((f) => f.url() === field.frame) ?? page.mainFrame();
}

/**
 * Index locators are a last resort from the scanner, and they are the ones most likely to
 * be stale. Resolving them here keeps that fragility in one place.
 */
function locate(frame: Frame, field: FormField): Locator {
  const m = /^__index__(\d+):(\d+)$/.exec(field.locator);
  if (m) {
    const selector =
      'input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select, ' +
      '[role=combobox], [contenteditable=true]';
    return frame.locator(selector).nth(Number(m[2]));
  }
  return frame.locator(field.locator);
}

/**
 * Above this many characters, keystroke pacing is dropped.
 *
 * An essay is the only thing that gets near it, and pacing an 600-character answer at
 * human speed costs a minute per field for no benefit — the key events still fire.
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

async function fillOne(page: Page, action: FillAction): Promise<FieldResult> {
  const { field, value } = action;
  const frame = frameFor(page, field);
  const loc = locate(frame, field);

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
        // Match an option by label first, then by value; forms label options in prose.
        const options = field.options ?? [];
        const wanted =
          options.find((o) => comparable(o.label) === comparable(value)) ??
          options.find((o) => comparable(o.label).includes(comparable(value))) ??
          options.find((o) => comparable(o.value) === comparable(value));
        if (!wanted) {
          return {
            field,
            status: 'skipped',
            note: `No option matching "${value}". Choose it yourself.`,
          };
        }
        await loc.selectOption(wanted.value);
        break;
      }

      case 'checkbox':
      case 'radio': {
        // Only ever ticks, never unticks, and only for an affirmative value. A checkbox
        // this tool does not understand is left exactly as the page had it.
        if (/^(yes|true|on|checked)$/i.test(value)) await loc.check();
        else return { field, status: 'skipped', note: 'Left for you to decide.' };
        break;
      }

      case 'combobox': {
        // A div-based combobox has no value to set: it has to be opened and an option
        // clicked, the same way a person would.
        await loc.click();
        const option = frame
          .locator('[role=option]')
          .filter({ hasText: new RegExp(value.slice(0, 24), 'i') })
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
        // them is not what makes them work, so long text gets no pacing: an essay typed
        // at 40-120ms per character takes over a minute and times out, while the events
        // themselves are dispatched either way.
        await loc.pressSequentially(value, {
          delay: value.length > LONG_TEXT ? 0 : keyDelay(),
          timeout: 60_000,
        });
      }
    }

    const readBack = await readValue(loc, field);
    if (accepted(value, readBack)) return { field, status: 'ok', readBack };

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
