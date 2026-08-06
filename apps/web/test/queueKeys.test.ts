import { describe, expect, it } from 'vitest';
import { isTypingTarget, queueKeyAction } from '../src/lib/queueKeys';

/**
 * Gate G2 is a single unmodified letter. `a` records an approval, which creates a real
 * application on the server and cannot be undone from anywhere in the interface, so these
 * cases are about what must NOT reach that handler.
 */
describe('queueKeyAction', () => {
  const idle = { rejecting: false };

  it('runs the queue on a bare letter', () => {
    expect(queueKeyAction({ key: 'a' }, idle)).toBe('approve');
    expect(queueKeyAction({ key: 'A' }, idle)).toBe('approve');
    expect(queueKeyAction({ key: 's' }, idle)).toBe('skip');
    expect(queueKeyAction({ key: 'x' }, idle)).toBe('reject');
    expect(queueKeyAction({ key: 'l' }, idle)).toBe('save');
    expect(queueKeyAction({ key: 'j' }, idle)).toBe('next');
    expect(queueKeyAction({ key: 'k' }, idle)).toBe('prev');
  });

  it('ignores a letter held with any modifier', () => {
    // Ctrl+A is select-all, and it used to approve the selected posting instead. The
    // handler also suppressed the default, so no selection appeared either and the only
    // sign anything had happened was a posting silently leaving the queue with an
    // application created against it. Every modifier, not only the one in the report.
    expect(queueKeyAction({ key: 'a', ctrlKey: true }, idle)).toBeNull();
    expect(queueKeyAction({ key: 'a', metaKey: true }, idle)).toBeNull();
    expect(queueKeyAction({ key: 'a', altKey: true }, idle)).toBeNull();
    expect(queueKeyAction({ key: 'A', ctrlKey: true, shiftKey: true }, idle)).toBeNull();
    expect(queueKeyAction({ key: 's', ctrlKey: true }, idle)).toBeNull();
    expect(queueKeyAction({ key: 'l', metaKey: true }, idle)).toBeNull();
    expect(queueKeyAction({ key: 'x', altKey: true }, idle)).toBeNull();
    expect(queueKeyAction({ key: 'j', ctrlKey: true }, idle)).toBeNull();
  });

  it('still triages with Shift held, because that is how a capital letter is made', () => {
    expect(queueKeyAction({ key: 'A', shiftKey: true }, idle)).toBe('approve');
  });

  it('leaves the keystrokes of an input method editor alone', () => {
    expect(queueKeyAction({ key: 'a', isComposing: true }, idle)).toBeNull();
  });

  it('stays out of anywhere a person can type', () => {
    expect(queueKeyAction({ key: 'a', target: { tagName: 'INPUT' } }, idle)).toBeNull();
    expect(queueKeyAction({ key: 'a', target: { tagName: 'TEXTAREA' } }, idle)).toBeNull();
    expect(queueKeyAction({ key: 'a', target: { tagName: 'SELECT' } }, idle)).toBeNull();
    expect(queueKeyAction({ key: 'a', target: { isContentEditable: true } }, idle)).toBeNull();
  });

  it('still triages from a button or the page body', () => {
    expect(queueKeyAction({ key: 'a', target: { tagName: 'BUTTON' } }, idle)).toBe('approve');
    expect(queueKeyAction({ key: 'a', target: { tagName: 'BODY' } }, idle)).toBe('approve');
    expect(queueKeyAction({ key: 'a', target: null }, idle)).toBe('approve');
  });

  it('answers nothing for a key the queue does not use', () => {
    expect(queueKeyAction({ key: 'q' }, idle)).toBeNull();
    expect(queueKeyAction({ key: 'Enter' }, idle)).toBeNull();
    expect(queueKeyAction({ key: 'Escape' }, idle)).toBeNull();
  });

  it('closes the reject sheet on Escape and does nothing else while it is open', () => {
    const open = { rejecting: true };
    expect(queueKeyAction({ key: 'Escape' }, open)).toBe('close-sheet');
    expect(queueKeyAction({ key: 'a' }, open)).toBeNull();
    // Modifiers are checked before the sheet, so a chord cannot close it either.
    expect(queueKeyAction({ key: 'Escape', ctrlKey: true }, open)).toBeNull();
  });
});

describe('isTypingTarget', () => {
  it('is not fooled by a tag name that merely contains one of the words', () => {
    // The old check was a substring match, so a custom element named <fancy-select> was
    // treated as a text field. Anchored now.
    expect(isTypingTarget({ tagName: 'FANCY-SELECT' })).toBe(false);
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true);
  });

  it('treats a contenteditable element as a text field', () => {
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: false })).toBe(false);
  });
});
