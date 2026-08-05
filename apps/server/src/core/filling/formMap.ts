/// <reference lib="dom" />
/**
 * Reading a page into a FormMap — docs/07-form-automation.md § Building a FormMap.
 *
 * The whole page is read before anything is typed. That ordering is deliberate: it means
 * the redline pass and the "what is unknown here?" question are both answered while the
 * form is still untouched, so a run can be abandoned without having half-filled it.
 *
 * WHERE THE LABEL ACTUALLY LIVES. Six places, in descending reliability, because real ATS
 * forms use all of them and several use different ones on the same page:
 *
 *   1. `aria-labelledby` pointing at an element  (explicit, and survives restyling)
 *   2. `<label for=...>` or a wrapping `<label>` (the standard)
 *   3. `aria-label`                              (explicit, common in component libraries)
 *   4. a preceding sibling's text                (the ATS div-soup pattern)
 *   5. the enclosing container's own first text  (worse, but still better than nothing)
 *   6. `placeholder`                             (weakest; often an example, not a name)
 *
 * Extraction runs inside the page rather than over a serialized DOM, because resolving a
 * label means walking the tree and reading computed visibility, and shipping the whole
 * document back to Node to do that would be slower and lossier.
 */
import type { Frame, Page } from 'playwright';
import type { FormField } from '@ia/shared';
import { ulid } from 'ulid';
import { classifyField, type FieldDescriptor } from './classify';
import { checkRedline } from './redlines';

/** What the in-page scanner returns, before classification happens in Node. */
interface RawField extends FieldDescriptor {
  locator: string;
  control: FormField['control'];
  required: boolean;
  maxLength?: number;
  options?: Array<{ value: string; label: string }>;
  visible: boolean;
}

/**
 * Runs inside the browser. Written as a single self-contained function because Playwright
 * serializes it across the boundary — it cannot close over anything from this module.
 */
/* c8 ignore start — executes in the page context, covered by the fixture tests. */
const SCAN = (): unknown => {
  const text = (el: Element | null): string =>
    (el?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);

  const labelFor = (el: HTMLElement): string => {
    // 1. aria-labelledby
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const joined = by
        .split(/\s+/)
        .map((id) => text(document.getElementById(id)))
        .filter(Boolean)
        .join(' ');
      if (joined) return joined;
    }
    // 2. <label for> / wrapping label
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && text(l)) return text(l);
    }
    const wrapping = el.closest('label');
    if (wrapping && text(wrapping)) return text(wrapping);

    // 3. aria-label
    const aria = el.getAttribute('aria-label');
    if (aria?.trim()) return aria.trim();

    const CONTROLS = 'input, textarea, select, [role=combobox], [contenteditable=true]';

    // 4. previous sibling text, walking back over empty nodes.
    //
    // Stops at the first sibling that IS or CONTAINS another control. Without that guard
    // the walk sails past a neighbouring input and returns ITS label, which is worse than
    // returning nothing: the field gets confidently classified as the wrong thing.
    let prev = el.previousElementSibling;
    for (let i = 0; i < 3 && prev; i++) {
      if (prev.matches(CONTROLS) || prev.querySelector(CONTROLS)) break;
      const t = text(prev);
      if (t && t.length < 200) return t;
      prev = prev.previousElementSibling;
    }

    // 5. the container's own text, but ONLY when the container wraps this control alone.
    //
    // A <form> is also a parent, and searching it for something label-shaped would hand
    // back the first label on the page for every unlabelled field on it.
    const parent = el.parentElement;
    if (parent && parent.querySelectorAll(CONTROLS).length === 1) {
      const own = Array.from(parent.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => (n.textContent ?? '').trim())
        .filter(Boolean)
        .join(' ');
      if (own) return own.slice(0, 200);
      const labelish = parent.querySelector('[class*="label" i], legend, dt, h1, h2, h3, h4');
      if (labelish && text(labelish)) return text(labelish);
    }

    // 6. placeholder, last
    return (el.getAttribute('placeholder') ?? '').trim();
  };

  /** A selector that will still find this element later. */
  const locatorFor = (el: HTMLElement, index: number): string => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const name = el.getAttribute('name');
    if (name && document.querySelectorAll(`[name="${CSS.escape(name)}"]`).length === 1) {
      return `[name="${CSS.escape(name)}"]`;
    }
    // Fall back to position among all controls. Verified by label read-back at fill time,
    // so a shifted index is caught rather than silently filling the wrong box.
    return `__index__${String(index)}`;
  };

  const controlOf = (el: HTMLElement): string => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return 'textarea';
    if (tag === 'select') return (el as HTMLSelectElement).multiple ? 'multiselect' : 'select';
    if (el.getAttribute('role') === 'combobox') return 'combobox';
    if (el.isContentEditable) return 'richtext';
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'radio') return 'radio';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'file') return 'file';
    if (type === 'date' || type === 'month') return 'date';
    return 'text';
  };

  // Must stay identical to FILLABLE_CONTROLS in ./selectors.ts. It cannot import it:
  // this function is serialized into the page and closes over nothing. A test asserts
  // the two match, because a drift here makes an index locator resolve to the wrong
  // element, and dropping the image/reset exclusions would let a click submit the form.
  const SELECTOR =
    'input:not([type=hidden]):not([type=submit]):not([type=button])' +
    ':not([type=image]):not([type=reset]), ' +
    'textarea, select, [role=combobox], [contenteditable=true]';

  // Includes shadow roots, which Playwright can reach but querySelectorAll cannot.
  const collect = (root: Document | ShadowRoot, out: HTMLElement[]): void => {
    out.push(...Array.from(root.querySelectorAll<HTMLElement>(SELECTOR)));
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      if (el.shadowRoot) collect(el.shadowRoot, out);
    }
  };

  const els: HTMLElement[] = [];
  collect(document, els);

  return els.map((el, index) => {
    const control = controlOf(el);
    const input = el as HTMLInputElement & HTMLSelectElement;
    const label = labelFor(el);
    const rect = el.getBoundingClientRect();

    return {
      locator: locatorFor(el, index),
      label,
      name: el.getAttribute('name') ?? undefined,
      id: el.id || undefined,
      autocomplete: el.getAttribute('autocomplete') ?? undefined,
      placeholder: el.getAttribute('placeholder') ?? undefined,
      type: control === 'textarea' ? 'textarea' : (el.getAttribute('type') ?? undefined),
      control,
      // An asterisk in the label is how a great many forms mark required, and it is not
      // reflected in the attribute.
      required:
        el.hasAttribute('required') ||
        el.getAttribute('aria-required') === 'true' ||
        /\*\s*$/.test(label),
      maxLength: input.maxLength && input.maxLength > 0 ? input.maxLength : undefined,
      options:
        control === 'select' || control === 'multiselect'
          ? Array.from(input.options ?? []).map((o) => ({ value: o.value, label: o.text }))
          : undefined,
      visible: rect.width > 0 && rect.height > 0,
    };
  });
};
/* c8 ignore stop */

export interface FormMap {
  url: string;
  fields: FormField[];
  /** Fields that were found but cannot be acted on, kept so the UI can list them. */
  unknown: FormField[];
  redlined: FormField[];
}

async function scanFrame(frame: Frame): Promise<RawField[]> {
  try {
    return (await frame.evaluate(SCAN)) as RawField[];
  } catch {
    // A frame can navigate or be cross-origin mid-scan. Losing one frame is survivable;
    // failing the whole run because of it is not.
    return [];
  }
}

/**
 * Reads every frame of the page into one map.
 *
 * Invisible controls are dropped: forms routinely carry hidden inputs for CSRF tokens and
 * for the branches of a conditional the user has not reached, and neither is ours to fill.
 */
export async function buildFormMap(page: Page): Promise<FormMap> {
  const fields: FormField[] = [];

  for (const frame of page.frames()) {
    const raw = await scanFrame(frame);
    const isMain = frame === page.mainFrame();

    raw.forEach((r, i) => {
      if (!r.visible) return;

      const classification = classifyField(r);
      const red = checkRedline(r);

      fields.push({
        id: ulid(),
        // Index locators are resolved against this frame's own ordering.
        locator: r.locator.startsWith('__index__') ? `${r.locator}:${String(i)}` : r.locator,
        label: r.label || '(no label found)',
        control: r.control,
        required: r.required,
        maxLength: r.maxLength,
        options: r.options,
        semantic: classification.semantic,
        redlineCategory: red?.category,
        confidence: classification.confidence,
        frame: isMain ? undefined : frame.url(),
      });
    });
  }

  return {
    url: page.url(),
    fields,
    unknown: fields.filter((f) => f.semantic === 'unknown'),
    redlined: fields.filter((f) => f.semantic === 'REDLINE'),
  };
}

/** One line for the run log and the pre-submit summary. */
export function summarizeMap(map: FormMap): string {
  const fillable = map.fields.length - map.unknown.length - map.redlined.length;
  return (
    `${map.fields.length} fields found: ${fillable} fillable, ` +
    `${map.redlined.length} left for you, ${map.unknown.length} not recognized.`
  );
}
