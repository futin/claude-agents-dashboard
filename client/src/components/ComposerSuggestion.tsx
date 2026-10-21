import type { KeyboardEvent } from 'react';

import { TOUCH_QUERY, composerKey } from '../lib/composer';

/**
 * The keydown handler both chat drawer composers share (`MessagePanel`, `ResumePanel`): Enter sends through `onSend` when `canSend` — the same guard as
 * the send button — and Tab in an empty box takes `suggestion`. `keyCode` 229 is Safari's IME keydown, which does not set `isComposing`.
 */
export function composerKeyDown({ text, suggestion, canSend, onSend, onAccept }: {
  text: string;
  suggestion: string | null;
  canSend: boolean;
  onSend(): void;
  onAccept(text: string): void;
}) {
  return (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const k = composerKey(
      {
        key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey,
        isComposing: e.nativeEvent.isComposing || e.keyCode === 229
      },
      { touch: window.matchMedia(TOUCH_QUERY).matches, empty: text === '', suggestion }
    );
    if (!k) return;
    e.preventDefault();
    if (k === 'accept' && suggestion) onAccept(suggestion);
    else if (k === 'send' && canSend) onSend();
  };
}

/**
 * The suggested reply under an empty composer — the tap target a phone needs, since its keyboard has no Tab. The `kbd` hint hides on touch (styles.css).
 */
export function SuggestionChip({ suggestion, disabled, onAccept }: {
  suggestion: string;
  disabled?: boolean;
  onAccept(text: string): void;
}) {
  return (
    <button type="button" className="qp-suggest" disabled={disabled} onClick={() => onAccept(suggestion)}>
      <kbd>Tab</kbd>
      <span className="qp-suggest-text">{suggestion}</span>
    </button>
  );
}
