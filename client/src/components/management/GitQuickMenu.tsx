import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject, SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';

import type { QuickItem } from '../../lib/gitQuick';

export interface GitQuickMenuItem extends QuickItem {
  key: 'pull' | 'push' | 'sync';
  label: string;
  run(): void;
}

/** The gap between the caret and the menu, and the menu's least distance from a viewport edge. */
const GAP = 4;
const EDGE = 8;

/**
 * The Sync key's menu (quick pull/push spec §The UI): Pull, Push, then Sync with Claude below a rule. On body, outside `.shell`, so a fixed box sits in
 * the same viewport pixels the caret is measured in. Every event inside stops at the menu: React bubbles portal events through the component tree, and
 * the row the key sits in would otherwise toggle.
 */
export function GitQuickMenu({ anchor, items, label, onClose }: {
  anchor: RefObject<HTMLButtonElement | null>;
  items: GitQuickMenuItem[];
  label: string;
  /** `refocus`: hand focus back to the caret (Escape, or an item ran); an outside click or a scroll leaves focus where the user put it. */
  onClose(refocus: boolean): void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Under the caret, right edges aligned; above it when below would leave the viewport.
  useLayoutEffect(() => {
    const a = anchor.current?.getBoundingClientRect();
    const m = menuRef.current?.getBoundingClientRect();
    if (!a || !m) return;
    const below = a.bottom + GAP;
    const top = below + m.height > window.innerHeight - EDGE && a.top - GAP - m.height >= EDGE ? a.top - GAP - m.height : below;
    const left = Math.min(Math.max(EDGE, a.right - m.width), window.innerWidth - EDGE - m.width);
    setPos({ left, top });
  }, [anchor]);

  useEffect(() => {
    const first = items.findIndex(i => i.enabled);
    itemRefs.current[first === -1 ? 0 : first]?.focus();
    // `items` is fresh every render; focus is placed once, when the menu opens.
  }, []);

  useEffect(() => {
    const outside = (e: Event) => {
      const t = e.target as Node | null;
      if (t && (menuRef.current?.contains(t) || anchor.current?.contains(t))) return;
      onCloseRef.current(false);
    };
    const close = () => onCloseRef.current(false);
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [anchor]);

  const enabledIdx = items.flatMap((it, i) => (it.enabled ? [i] : []));
  const fire = (it: GitQuickMenuItem) => {
    if (!it.enabled) return;
    onCloseRef.current(true);
    it.run();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const at = itemRefs.current.findIndex(el => el === document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      onCloseRef.current(true);
    } else if (e.key === 'Tab') {
      onCloseRef.current(false);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (enabledIdx.length === 0) return;
      const pos = enabledIdx.indexOf(at);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = pos === -1 ? (step === 1 ? 0 : enabledIdx.length - 1) : (pos + step + enabledIdx.length) % enabledIdx.length;
      itemRefs.current[enabledIdx[next]]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      if (enabledIdx.length > 0) itemRefs.current[enabledIdx[e.key === 'Home' ? 0 : enabledIdx.length - 1]]?.focus();
    }
  };
  const stop = (e: SyntheticEvent) => e.stopPropagation();

  return createPortal(
    <div
      ref={menuRef}
      className="git-qm"
      role="menu"
      aria-label={label}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
      onKeyDown={onKeyDown}
      onClick={stop}
      onPointerDown={stop}
    >
      {items.map((it, i) => (
        <Fragment key={it.key}>
          {it.key === 'sync' && <div className="git-qm-sep" role="separator" />}
          <button
            ref={el => { itemRefs.current[i] = el; }}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="git-qm-item"
            aria-disabled={!it.enabled}
            onClick={() => fire(it)}
            onKeyDown={e => {
              // Enter and Space would also click the button; handling them here runs the item exactly once.
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fire(it);
              }
            }}
          >
            <span className="git-qm-label">{it.label}</span>
            <span className="git-qm-sub">{it.sub}</span>
          </button>
        </Fragment>
      ))}
    </div>,
    document.body
  );
}
