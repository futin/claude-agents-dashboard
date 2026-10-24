import { useState, type ChangeEvent } from 'react';

/**
 * Props for an input or textarea that shows what is being typed while it has focus and the file's value once it loses it. A keystroke reaches `commit`
 * only when `accept` says the value is whole, so a half-typed minute or turn count never lands in the job file, and a value the write normalises (a trimmed
 * prompt, `09` read back as `9`) never jumps under the caret. Blur drops the draft: what stays on screen is what the file now says.
 */
export function useDraft<E extends HTMLInputElement | HTMLTextAreaElement>(
  value: string,
  commit: (s: string) => void,
  accept: (s: string) => boolean = () => true
): { value: string; onChange(e: ChangeEvent<E>): void; onBlur(): void } {
  const [draft, setDraft] = useState<string | null>(null);
  return {
    value: draft ?? value,
    onChange: e => {
      const s = e.target.value;
      setDraft(s);
      if (accept(s)) commit(s);
    },
    onBlur: () => setDraft(null)
  };
}
