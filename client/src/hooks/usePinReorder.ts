import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

import { dropIndex, movePin } from '../lib/pins';
import type { PinRect } from '../lib/pins';
import type { PinRow } from '../../../shared/types';

/** What a pinned item's grip button spreads onto itself. */
export interface GripProps {
  ref: (el: HTMLButtonElement | null) => void;
  onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => void;
  'aria-label': string;
  'aria-disabled': 'true' | undefined;
}

export interface PinReorder {
  /** The order to draw the pins in while a drag runs, else null. */
  dragOrder: string[] | null;
  /** The dirName being dragged, else null. */
  dragging: string | null;
  grip: (dirName: string) => GripProps;
  /** The ref for a pinned item's element — the box `dropIndex` reads. */
  rowRef: (dirName: string) => (el: HTMLElement | null) => void;
  /** True for 1500ms after each successful write. */
  saved: boolean;
  /** A refused write whose pin is gone (the usual 409): shown beside the Pinned heading in place of `Saved`. */
  headError: string | null;
  /** A refused write's text, under the pin it moved. */
  errorFor: (dirName: string) => string | null;
  /** End any drag without writing and clear the reorder error: the view calls it before a Pin or Unpin. */
  cancel: () => void;
}

/** A drag in flight. Lives in a ref because its document listeners outlast the render that started it. */
interface Drag {
  id: number;
  name: string;
  start: string[];
  draft: string[];
  x: number;
  y: number;
  frame: number;
  detach: () => void;
}

/** Pointer this close to the viewport's top or bottom scrolls the page: 50 pins outgrow a phone screen. */
const EDGE_PX = 48;
const SCROLL_STEP_PX = 10;
const SAVED_MS = 1500;

const sameOrder = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((d, i) => d === b[i]);

/**
 * Management › Projects' pin reorder (#191's rules, #193's placement): a drag on a pinned item's grip, or an arrow key on it focused, saves the new order at
 * once through `reorder`. The drag listens on `document` and never captures the pointer — React re-placing the dragged `<li>` releases capture, which froze
 * a captured drag after one swap. Each move re-runs `dropIndex` over every pinned item's live box, so one rule serves a one-column list and a Tiles grid.
 * Only a release that changed the order writes; cancel, Escape and an unchanged drop restore it. `filterBlank` false means the view hides the grips — a
 * filtered list has gaps, so a drop position would be ambiguous — and a drag running when it turns false cancels.
 */
export function usePinReorder(
  pinned: PinRow[],
  busy: string | null,
  reorder: (order: string[]) => Promise<string | null>,
  filterBlank: boolean
): PinReorder {
  // A refused write: its text goes under the moved pin, or beside the heading when that pin is gone (the usual 409).
  const [error, setError] = useState<{ dirName: string; text: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [dragView, setDragView] = useState<{ name: string; order: string[] } | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const rows = useRef(new Map<string, HTMLElement>());
  const grips = useRef(new Map<string, HTMLButtonElement>());
  // The grip a key press moved, held until that save has fully landed: React re-placing its focused <li> drops focus to <body>, and so does the rollback.
  const pendingFocus = useRef<string | null>(null);
  const savedTimer = useRef(0);
  const live = useRef(reorder);
  live.current = reorder;

  async function save(order: string[], name: string): Promise<void> {
    setError(null);
    setSaved(false);
    window.clearTimeout(savedTimer.current);
    const text = await live.current(order);
    if (text) {
      setError({ dirName: name, text });
      return;
    }
    setSaved(true);
    savedTimer.current = window.setTimeout(() => setSaved(false), SAVED_MS);
  }

  /** Re-run the drop rule at the pointer over the items' boxes as laid out right now. */
  function follow(): void {
    const d = dragRef.current;
    if (!d) return;
    // Read the order off the page rather than the draft: a move can land before React has committed the last one, and the boxes are the page's.
    const els = d.draft.flatMap(name => {
      const el = rows.current.get(name);
      return el ? [{ name, el }] : [];
    });
    if (els.length !== d.draft.length) return;
    els.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const shown = els.map(e => e.name);
    const items = els.map(({ name, el }): { name: string; rect: PinRect } => ({ name, rect: el.getBoundingClientRect() }));
    const to = dropIndex(items, d.name, { x: d.x, y: d.y });
    if (to < 0) return;
    const order = movePin(shown, d.name, to);
    if (sameOrder(order, d.draft)) return;
    d.draft = order;
    setDragView({ name: d.name, order });
  }

  function autoScroll(): void {
    const d = dragRef.current;
    if (!d || d.frame) return;
    const step = (): void => {
      const cur = dragRef.current;
      if (!cur) return;
      cur.frame = 0;
      const dir = cur.y < EDGE_PX ? -1 : cur.y > window.innerHeight - EDGE_PX ? 1 : 0;
      if (dir === 0) return;
      window.scrollBy(0, dir * SCROLL_STEP_PX);
      follow(); // the items moved under a still pointer
      cur.frame = requestAnimationFrame(step);
    };
    d.frame = requestAnimationFrame(step);
  }

  function finishDrag(commit: boolean): void {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    d.detach();
    setDragView(null);
    if (commit && !sameOrder(d.draft, d.start)) void save(d.draft, d.name);
  }

  function startDrag(e: ReactPointerEvent<HTMLButtonElement>, name: string): void {
    // aria-disabled blocks nothing by itself, and reorder does not check busy: without this a drag begun under a Pin/Unpin writes an order under it.
    if (busy !== null || dragRef.current || !filterBlank) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault(); // no text selection while dragging
    const start = pinned.map(r => r.dirName);
    const id = e.pointerId;
    const onMove = (ev: PointerEvent): void => {
      const d = dragRef.current;
      if (!d || ev.pointerId !== id) return;
      d.x = ev.clientX;
      d.y = ev.clientY;
      follow();
      autoScroll();
    };
    const onUp = (ev: PointerEvent): void => { if (ev.pointerId === id) finishDrag(true); };
    const onCancel = (ev: PointerEvent): void => { if (ev.pointerId === id) finishDrag(false); };
    // On document, since focus need not be on the grip.
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      finishDrag(false);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    document.addEventListener('keydown', onKey);
    const drag: Drag = {
      id, name, start, draft: start, x: e.clientX, y: e.clientY, frame: 0,
      detach: () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onCancel);
        document.removeEventListener('keydown', onKey);
        cancelAnimationFrame(drag.frame);
      }
    };
    dragRef.current = drag;
    setDragView({ name, order: start });
  }

  function onGripKey(e: ReactKeyboardEvent<HTMLButtonElement>, name: string): void {
    // ← and → too: on a grid, one place earlier is to the left. Neither key ever jumps a row.
    const step = e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : 0;
    if (step === 0) return;
    e.preventDefault(); // the page must not scroll, even when the press is dropped
    if (busy !== null || dragRef.current) return;
    const order = pinned.map(r => r.dirName);
    const next = movePin(order, name, order.indexOf(name) + step);
    if (next === order) return;
    pendingFocus.current = name;
    void save(next, name);
  }

  // A pinned change mid-drag (only this tab's own Pin/Unpin reply can make one) restarts the draft from the new order.
  useEffect(() => {
    const d = dragRef.current;
    if (!d) return;
    const now = pinned.map(r => r.dirName);
    if (!now.includes(d.name)) return finishDrag(false);
    d.start = now;
    d.draft = now;
    setDragView({ name: d.name, order: now });
  }, [pinned]);

  // A Pin/Unpin starting mid-drag (a second finger) cancels it. busy back to null means the last save has landed — rollback included — so the focus
  // mark goes here and not after the await: that continuation shares a commit with the rollback, whose layout effect still needs the mark.
  useEffect(() => {
    if (busy !== null) finishDrag(false);
    else pendingFocus.current = null;
  }, [busy]);

  useEffect(() => {
    if (!filterBlank) finishDrag(false);
  }, [filterBlank]);

  // Every pinned change while a key press is pending, not just the first: the rollback after a refused save moves the item back too.
  useLayoutEffect(() => {
    const name = pendingFocus.current;
    if (!name) return;
    const grip = grips.current.get(name);
    const active = document.activeElement;
    const ours = active === null || active === document.body || (active instanceof HTMLElement && active.classList.contains('pin-grip'));
    if (grip && active !== grip && ours) grip.focus({ preventScroll: true });
  }, [pinned]);

  useEffect(() => () => {
    dragRef.current?.detach();
    window.clearTimeout(savedTimer.current);
  }, []);

  const shownOrder = dragView?.order ?? pinned.map(r => r.dirName);
  return {
    dragOrder: dragView?.order ?? null,
    dragging: dragView?.name ?? null,
    grip: name => ({
      ref: el => { if (el) grips.current.set(name, el); else grips.current.delete(name); },
      onPointerDown: e => startDrag(e, name),
      onKeyDown: e => onGripKey(e, name),
      'aria-label': `Move ${pinned.find(r => r.dirName === name)?.name ?? name}, position ${shownOrder.indexOf(name) + 1} of ${pinned.length}`,
      'aria-disabled': busy !== null ? 'true' : undefined,
    }),
    rowRef: name => el => { if (el) rows.current.set(name, el); else rows.current.delete(name); },
    saved,
    headError: error && !pinned.some(r => r.dirName === error.dirName) ? error.text : null,
    errorFor: name => (error?.dirName === name ? error.text : null),
    cancel: () => {
      finishDrag(false);
      setError(null);
    },
  };
}
