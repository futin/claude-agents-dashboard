import { useEffect, type ReactNode, type RefObject } from 'react';

/**
 * Close on a pointer-down outside `ref`, or on Escape. The outside test is
 * against the *anchor* wrapper rather than the popover itself, so a click on
 * the button that opened it toggles instead of closing-then-reopening. The
 * same handling `MultiSelect` had, lifted out so the two toolbar popovers
 * share it.
 */
export function useDismiss(ref: RefObject<HTMLElement>, open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, open, onClose]);
}

/**
 * The floating surface under a toolbar button (DESIGN.md §5: the one thing
 * besides the shell that floats). Positioned by its `.ctlwrap` parent; the
 * dismiss handling lives on that parent via `useDismiss`.
 */
export function Popover({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="pop" role="dialog" aria-label={label}>
      {children}
    </div>
  );
}
