/**
 * What a keypress on the review queue means, or nothing at all.
 *
 * This lives outside the component because the letters it reads are gate G2: `a` records
 * an approval, which creates a real application on the server and cannot be taken back
 * through any control on the screen. A decision that consequential should be decidable in
 * a test rather than only in a browser.
 */

export type QueueKeyAction =
  'next' | 'prev' | 'approve' | 'skip' | 'reject' | 'save' | 'close-sheet';

/**
 * The parts of a KeyboardEvent this decision reads.
 *
 * `shiftKey` is listed and deliberately ignored: Shift is what a capital letter is made
 * of, so blocking it would mean the queue stopped responding to anyone holding it down or
 * with caps lock on, and Shift on its own is not a chord that means something else.
 */
export interface QueueKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  target?: unknown;
}

/**
 * Anchored, and aware of contenteditable.
 *
 * The old test was a substring match on the tag name, which is both too loose and too
 * narrow: it would have matched a custom element merely NAMED something-select, while a
 * rich-text box — a `div` with `contenteditable` — is not a tag name at all, so every
 * letter typed into one was read as a triage command instead. The rule is that anywhere a
 * person can type is a place these shortcuts stay out of.
 */
export function isTypingTarget(target: unknown): boolean {
  const t = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!t) return false;
  if (t.isContentEditable === true) return true;
  return typeof t.tagName === 'string' && /^(input|textarea|select)$/i.test(t.tagName);
}

/**
 * A bare letter, and only a bare letter.
 *
 * Every shortcut here is one unmodified character, so anything held down with it belongs
 * to the browser or the operating system rather than to this queue. Without that check
 * Ctrl+A — select all, the most ordinary chord there is — ran the approve handler, and
 * because the handler also called preventDefault the selection never appeared either, so
 * the only sign anything had happened was a posting quietly leaving the list with an
 * application created against it. Cmd+A and Alt+A did the same, as did Ctrl+S over Skip
 * and Cmd+L over Save. The rule is: check EVERY modifier, not the one in the report, and
 * check it before the reject sheet's Escape so a chord cannot close that either.
 *
 * `isComposing` is the same idea for an input method editor: while a Japanese or Chinese
 * keyboard is mid-composition the keystrokes belong to the composition, not to us.
 */
export function queueKeyAction(
  e: QueueKeyEvent,
  opts: { rejecting: boolean },
): QueueKeyAction | null {
  if (e.ctrlKey === true || e.metaKey === true || e.altKey === true || e.isComposing === true) {
    return null;
  }
  if (isTypingTarget(e.target)) return null;

  if (opts.rejecting) return e.key === 'Escape' ? 'close-sheet' : null;

  switch (e.key.toLowerCase()) {
    case 'j':
      return 'next';
    case 'k':
      return 'prev';
    case 'a':
      return 'approve';
    case 's':
      return 'skip';
    case 'x':
      return 'reject';
    case 'l':
      return 'save';
    default:
      return null;
  }
}
