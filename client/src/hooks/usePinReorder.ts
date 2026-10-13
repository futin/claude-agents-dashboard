import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

import { dropIndex, dropMark, movePin } from '../lib/pins';
import type { DropMark, PinRect } from '../lib/pins';
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
  /** The dirName being dragged, else null. */
  dragging: string | null;
  /** The index a release would move the dragged pin to, else null: no drag, no move yet, or the pointer back over the start. */
  dropAt: number | null;
  /** `Moving <name> · <n> of <N>` while a drag runs, shown beside the Pinned heading in place of `Saved`; else null. */
  headLabel: string | null;
  /** The chip that follows the pointer while a drag runs: the pin's name and the position a release would give it. */
  ghost: { name: string; pos: string } | null;
  /** The ref for the ghost's element. The hook places it by style, so a pointer move costs no render. */
  ghostRef: (el: HTMLDivElement | null) => void;
  /** The drop line's box in viewport pixels while a release would move the pin, else null. */
  mark: DropMark | null;
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
  /** The order at drag start, renewed when `pinned` changes under the drag. */
  start: string[];
  x: number;
  y: number;
  frame: number;
  dropAt: number | null;
  detach: () => void;
}

/** Pointer this close to the viewport's top or bottom scrolls the page: 50 pins outgrow a phone screen. */
const EDGE_PX = 48;
const SCROLL_STEP_PX = 10;
const SAVED_MS = 1500;
/** On `document.body` while a drag runs: the grabbing cursor and no text selection everywhere, not only over the grip. */
const BODY_CLS = 'pj-dragging';

const sameMark = (a: DropMark | null, b: DropMark | null): boolean =>
  a === b || (a !== null && b !== null && a.orient === b.orient && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height);

/**
 * Management › Projects' pin reorder (#191's rules, #193's grip, spec §3's drop line): a drag on a pinned item's grip, or an arrow key on it focused, saves
 * the new order through `reorder`. Nothing moves until release: the source dims in place, a ghost chip follows the pointer, and a bar marks the gap the pin
 * would land in. A live re-sort under the pointer shifted every neighbour on each crossing, so the eye lost both the target and the item. Each move re-runs
 * `dropIndex` over the pinned items' live boxes, so one rule serves a one-column list and a Tiles grid, and `dropMark` boxes the bar off the same boxes.
 * The ghost is placed through its ref, not state: it changes on every pointermove, while `dropAt` and the bar change only when the pointer crosses a slot.
 * The drag listens on `document` and never captures the pointer: #193's capture froze a drag once React re-placed the dragged `<li>`, and the listeners
 * need none.
 * Only a release that would move the pin writes, once; cancel, Escape and a release over the start write nothing. `filterBlank` false means the view hides
 * the grips — a filtered list has gaps, so a drop position would be ambiguous — and a drag running when it turns false cancels.
 */
export function usePinReorder(
  pinned: PinRow[],
  busy: string | null,
  reorder: (order: string[]) => Promise<string | null>,
  filterBlank: boolean,
  gapPx: number
): PinReorder {
  // A refused write: its text goes under the moved pin, or beside the heading when that pin is gone (the usual 409).
  const [error, setError] = useState<{ dirName: string; text: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [dragView, setDragView] = useState<{ name: string; dropAt: number | null; mark: DropMark | null } | null>(null);
  const dragRef = useRef<Drag | null>(null);
  // The bar last handed to state, so a move that lands on the same box renders nothing.
  const shownMark = useRef<DropMark | null>(null);
  const ghostEl = useRef<HTMLDivElement | null>(null);
  const rows = useRef(new Map<string, HTMLElement>());
  const grips = useRef(new Map<string, HTMLButtonElement>());
  // The grip a key press moved, held until that save has fully landed: React re-placing its focused <li> drops focus to <body>, and so does the rollback.
  const pendingFocus = useRef<string | null>(null);
  const savedTimer = useRef(0);
  const live = useRef(reorder);
  live.current = reorder;
  const gap = useRef(gapPx);
  gap.current = gapPx;

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

  function placeGhost(): void {
    const d = dragRef.current;
    const el = ghostEl.current;
    if (!d || !el) return;
    el.style.left = d.x + 14 + 'px';
    el.style.top = d.y - 18 + 'px';
  }

  // Stable across renders, so React does not detach and re-attach the ghost's ref on every render of the view.
  const ghostRef = useRef((el: HTMLDivElement | null): void => {
    ghostEl.current = el;
    placeGhost();
  }).current;

  /** Re-run the drop rule at the pointer over the items' boxes as laid out right now. */
  function track(): void {
    const d = dragRef.current;
    if (!d) return;
    const els = d.start.flatMap(name => {
      const el = rows.current.get(name);
      return el ? [{ name, el }] : [];
    });
    if (els.length !== d.start.length) return;
    els.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const items = els.map(({ name, el }): { name: string; rect: PinRect } => ({ name, rect: el.getBoundingClientRect() }));
    const to = dropIndex(items, d.name, { x: d.x, y: d.y });
    if (to < 0) return;
    const dropAt = movePin(d.start, d.name, to) === d.start ? null : to;
    const mark = dropAt === null ? null : dropMark(items, d.name, to, gap.current);
    if (dropAt === d.dropAt && sameMark(mark, shownMark.current)) return;
    d.dropAt = dropAt;
    shownMark.current = mark;
    setDragView({ name: d.name, dropAt, mark });
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
      placeGhost();
      track(); // the items moved under a still pointer
      cur.frame = requestAnimationFrame(step);
    };
    d.frame = requestAnimationFrame(step);
  }

  function finishDrag(commit: boolean): void {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    d.detach();
    document.body.classList.remove(BODY_CLS);
    shownMark.current = null;
    setDragView(null);
    if (commit && d.dropAt !== null) void save(movePin(d.start, d.name, d.dropAt), d.name);
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
      placeGhost();
      track();
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
    // A wheel or trackpad scroll moves the items under a still pointer and fires no pointermove; capture also catches an inner scroller.
    const onScroll = (): void => track();
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    const drag: Drag = {
      id, name, start, x: e.clientX, y: e.clientY, frame: 0, dropAt: null,
      detach: () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onCancel);
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('scroll', onScroll, { capture: true });
        cancelAnimationFrame(drag.frame);
      }
    };
    dragRef.current = drag;
    document.body.classList.add(BODY_CLS);
    shownMark.current = null;
    setDragView({ name, dropAt: null, mark: null });
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

  // A pinned change mid-drag (only this tab's own Pin/Unpin reply can make one): the drop slot was counted against the old order, so it clears until the
  // next move re-reads the boxes.
  useEffect(() => {
    const d = dragRef.current;
    if (!d) return;
    const now = pinned.map(r => r.dirName);
    if (!now.includes(d.name)) return finishDrag(false);
    d.start = now;
    d.dropAt = null;
    shownMark.current = null;
    setDragView({ name: d.name, dropAt: null, mark: null });
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
    dragRef.current = null;
    document.body.classList.remove(BODY_CLS);
    window.clearTimeout(savedTimer.current);
  }, []);

  const total = pinned.length;
  const nameOf = (dirName: string): string => pinned.find(r => r.dirName === dirName)?.name ?? dirName;
  const at = dragView ? pinned.findIndex(r => r.dirName === dragView.name) : -1;
  const n = dragView?.dropAt != null ? dragView.dropAt + 1 : at + 1;
  return {
    dragging: dragView?.name ?? null,
    dropAt: dragView?.dropAt ?? null,
    headLabel: dragView ? `Moving ${nameOf(dragView.name)} · ${n} of ${total}` : null,
    ghost: dragView
      ? { name: nameOf(dragView.name), pos: dragView.dropAt != null ? `→ ${dragView.dropAt + 1} of ${total}` : `${at + 1} of ${total}` }
      : null,
    ghostRef,
    mark: dragView?.mark ?? null,
    grip: name => ({
      ref: el => { if (el) grips.current.set(name, el); else grips.current.delete(name); },
      onPointerDown: e => startDrag(e, name),
      onKeyDown: e => onGripKey(e, name),
      'aria-label': `Move ${nameOf(name)}, position ${pinned.findIndex(r => r.dirName === name) + 1} of ${total}`,
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
