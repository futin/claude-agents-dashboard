import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';

import { formatAgo } from '../lib/format';
import { applyPinOrder, matchesPinFilter, movePin, shortenHome, splitPath } from '../lib/pins';
import type { PinRow, ProjectRef } from '../../../shared/types';

interface Props {
  /** The projects on offer, newest-first: `older` in the launch sheet, `recent` + `older` in Settings. */
  projects: ProjectRef[];
  home: string;
  /** The dirName whose request is in flight — its button reads `Pinning…` or `Unpinning…`, the rest wait. */
  busy: string | null;
  /** Resolves null on success, else the reason to show under that row. */
  onPin: (dirName: string) => Promise<string | null>;
  /**
   * Management › Pinned only: the stored pins, listed above the offers under a
   * heading of their own and filtered by the same box, each with an Unpin.
   * Absent in the launch sheet, which has nowhere to unpin from.
   */
  pinned?: PinRow[];
  onUnpin?: (dirName: string) => Promise<string | null>;
  /** Management › Pinned only: save the pins in a new order. With `pinned` and `onUnpin`, it gives every pinned row a drag grip. */
  onReorder?: (order: string[]) => Promise<string | null>;
}

type Act = (dirName: string) => Promise<string | null>;

/** A drag in flight. Lives in a ref because its document listeners outlast the render that started it. */
interface Drag {
  id: number;
  name: string;
  start: string[];
  draft: string[];
  y: number;
  frame: number;
  detach: () => void;
}

/** Pointer this close to the viewport's top or bottom scrolls the page: 50 pins outgrow a phone screen. */
const EDGE_PX = 48;
const SCROLL_STEP_PX = 10;
const SAVED_MS = 1500;

const sameOrder = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((d, i) => d === b[i]);
const midY = (el: Element): number => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };

/**
 * The pin picker (#161): a filter box over name and path, then one row per
 * match — the `~` path with its basename as the title, the last-session age,
 * a **Pin** (or, for a stored pin, **Unpin**). Enter pins the first offered
 * match. Shared by the launch sheet and Management › Pinned, so both offer pins
 * the same way; Settings also hands it the pins, and the one filter runs over
 * both groups. A refusal shows inline under its row and changes nothing. A
 * click never moves a row by hand: the POST answers with the fresh payload
 * and the groups re-split from that.
 *
 * With `onReorder`, each pinned row leads with a grip (pin-reorder spec §4.3): drag it, or ↑/↓ on it focused, and the new order saves at once. The drag
 * listens on `document` and never captures the pointer — React re-places the dragged row's `<li>` on a downward swap, and moving a node releases capture,
 * which froze a captured drag after one swap.
 */
export default function PinPicker({ projects, home, busy, onPin, pinned, onUnpin, onReorder }: Props) {
  const [query, setQuery] = useState('');
  // `order` marks a refused reorder: its text goes under the moved row, or beside the heading when that row is gone (the usual 409).
  const [error, setError] = useState<{ dirName: string; text: string; order?: boolean } | null>(null);
  const [saved, setSaved] = useState(false);
  const [dragView, setDragView] = useState<{ name: string; order: string[] } | null>(null);
  const matches = projects.filter(r => matchesPinFilter(r, query));
  const pinnedMatches = (pinned ?? []).filter(r => matchesPinFilter(r, query));

  const gripsOn = Boolean(pinned && onUnpin && onReorder);
  // A filtered list has gaps, so a drop position would be ambiguous.
  const showGrips = gripsOn && query.trim() === '';
  const dragRef = useRef<Drag | null>(null);
  const rows = useRef(new Map<string, HTMLLIElement>());
  const grips = useRef(new Map<string, HTMLButtonElement>());
  // The grip a key press moved, held until that save has fully landed: React re-placing its focused <li> drops focus to <body>, and so does the rollback.
  const pendingFocus = useRef<string | null>(null);
  const savedTimer = useRef(0);
  const live = useRef({ onReorder });
  live.current = { onReorder };

  async function act(dirName: string, fn: Act, clearQuery: boolean): Promise<void> {
    if (busy) return;
    finishDrag(false);
    setError(null);
    const text = await fn(dirName);
    if (text) setError({ dirName, text });
    else if (clearQuery) setQuery('');
  }

  const errorFor = (dirName: string): string | null => (error?.dirName === dirName ? error.text : null);
  const headError = error?.order && !pinned?.some(r => r.dirName === error.dirName) ? error.text : null;

  async function save(order: string[], name: string): Promise<void> {
    const reorder = live.current.onReorder;
    if (!reorder) return;
    setError(null);
    setSaved(false);
    window.clearTimeout(savedTimer.current);
    const text = await reorder(order);
    if (text) {
      setError({ dirName: name, text, order: true });
      return;
    }
    setSaved(true);
    savedTimer.current = window.setTimeout(() => setSaved(false), SAVED_MS);
  }

  /** Swap the dragged row past each neighbour whose vertical midpoint the pointer has crossed. */
  function follow(): void {
    const d = dragRef.current;
    if (!d) return;
    let order = d.draft;
    for (;;) {
      const i = order.indexOf(d.name);
      const prev = i > 0 ? rows.current.get(order[i - 1]) : undefined;
      const next = i >= 0 && i < order.length - 1 ? rows.current.get(order[i + 1]) : undefined;
      if (prev && d.y < midY(prev)) order = movePin(order, d.name, i - 1);
      else if (next && d.y > midY(next)) order = movePin(order, d.name, i + 1);
      else break;
    }
    if (order === d.draft) return;
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
      follow(); // the rows moved under a still pointer
      cur.frame = requestAnimationFrame(step);
    };
    d.frame = requestAnimationFrame(step);
  }

  /** End the drag, if one runs. Only a release that changed the order writes; cancel, Escape and an unchanged drop restore it. */
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
    if (busy !== null || dragRef.current || !pinned) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault(); // no text selection while dragging
    const start = pinned.map(r => r.dirName);
    const id = e.pointerId;
    const onMove = (ev: PointerEvent): void => {
      const d = dragRef.current;
      if (!d || ev.pointerId !== id) return;
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
      id, name, start, draft: start, y: e.clientY, frame: 0,
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
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault(); // the page must not scroll, even when the press is dropped
    if (busy !== null || dragRef.current || !pinned) return;
    const order = pinned.map(r => r.dirName);
    const next = movePin(order, name, order.indexOf(name) + (e.key === 'ArrowUp' ? -1 : 1));
    if (next === order) return;
    pendingFocus.current = name;
    void save(next, name);
  }

  // A pinned change mid-drag (only this tab's own Pin/Unpin reply can make one) restarts the draft from the new order.
  useEffect(() => {
    const d = dragRef.current;
    if (!d || !pinned) return;
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

  // Every pinned change while a key press is pending, not just the first: the rollback after a refused save moves the row back too.
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

  const shownPinned = dragView && pinned ? applyPinOrder(pinned, dragView.order) : pinnedMatches;
  const offersNote = projects.length === 0
    ? (pinned ? 'Every project active in the last 30 days is already pinned.' : null)
    : matches.length === 0 ? 'No project matches.' : null;

  return (
    <div className="pin-pick">
      <input
        className="qp-other"
        type="text"
        placeholder="Filter by name or path"
        aria-label="Filter projects"
        value={query}
        onChange={e => {
          if (e.target.value.trim() !== '') finishDrag(false);
          setQuery(e.target.value);
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' && matches.length > 0) {
            e.preventDefault();
            void act(matches[0].dirName, onPin, true);
          }
        }}
      />
      <div className={gripsOn ? 'pin-head g' : 'pin-head'}>{gripsOn && <span />}<span>Project</span><span>Last session</span></div>
      {pinned && onUnpin && (
        <>
          <div className="pin-group">
            Pinned<span className="pin-count">{pinned.length}</span>
            {gripsOn && (headError
              ? <span className="pin-saved err" role="status">{headError}</span>
              : <span className={saved ? 'pin-saved' : 'pin-saved off'} role="status" aria-hidden={!saved}>Saved</span>)}
          </div>
          {shownPinned.length > 0 ? (
            <ul className="pin-list">
              {shownPinned.map((row, i) => (
                <PinEntry
                  key={row.dirName}
                  path={row.path}
                  name={row.name}
                  home={home}
                  lastActiveMs={row.lastActiveMs}
                  dead={!row.listed}
                  error={errorFor(row.dirName)}
                  dragging={dragView?.name === row.dirName}
                  rowRef={gripsOn ? el => { if (el) rows.current.set(row.dirName, el); else rows.current.delete(row.dirName); } : undefined}
                  grip={!gripsOn ? undefined : showGrips ? (
                    <button
                      type="button"
                      className="pin-grip"
                      ref={el => { if (el) grips.current.set(row.dirName, el); else grips.current.delete(row.dirName); }}
                      aria-label={`Move ${row.name}, position ${i + 1} of ${pinned.length}`}
                      aria-disabled={busy !== null ? 'true' : undefined}
                      onPointerDown={e => startDrag(e, row.dirName)}
                      onKeyDown={e => onGripKey(e, row.dirName)}
                    >⠿</button>
                  ) : <span aria-hidden="true" />}
                >
                  <button type="button" className="qp-term" disabled={busy !== null} onClick={() => void act(row.dirName, onUnpin, false)}>
                    {busy === row.dirName ? 'Unpinning…' : 'Unpin'}
                  </button>
                </PinEntry>
              ))}
            </ul>
          ) : (
            <span className="sp-note">{pinned.length === 0 ? 'No projects are pinned.' : 'No pinned project matches.'}</span>
          )}
          <div className="pin-group">Not pinned<span className="pin-count">{projects.length}</span></div>
        </>
      )}
      {matches.length > 0 && (
        <ul className="pin-list">
          {matches.map(r => (
            <PinEntry key={r.dirName} path={r.path} name={r.name} home={home} lastActiveMs={r.lastActiveMs} error={errorFor(r.dirName)}>
              <button type="button" className="qp-term" disabled={busy !== null} onClick={() => void act(r.dirName, onPin, true)}>
                {busy === r.dirName ? 'Pinning…' : 'Pin'}
              </button>
            </PinEntry>
          ))}
        </ul>
      )}
      {offersNote && <span className="sp-note">{offersNote}</span>}
    </div>
  );
}

/**
 * One row. The path is the title: parents dim, basename bright, each segment
 * an atomic inline so a line breaks only between segments (a lone over-long
 * one still wraps inside itself). A dead pin, or a refused click, gets a line
 * under the path; the age column stays blank when no session is left to date.
 */
function PinEntry({
  path, name, home, lastActiveMs, dead, error, grip, dragging, rowRef, children
}: {
  path: string | null; name: string; home: string; lastActiveMs: number | null;
  dead?: boolean; error: string | null;
  /** The lead column: a grip, an empty cell while the filter hides grips, or undefined for a row with no lead column. */
  grip?: ReactNode; dragging?: boolean; rowRef?: (el: HTMLLIElement | null) => void;
  children: ReactNode;
}) {
  const shown = path === null ? { dirs: [], name } : splitPath(shortenHome(path, home));
  const cls = grip === undefined ? 'pin-row' : dragging ? 'pin-row g drag' : 'pin-row g';
  return (
    <li className={cls} ref={rowRef}>
      {grip}
      <span className="pin-path">
        {shown.dirs.map((d, i) => <span key={i} className="pin-seg">{d}</span>)}
        <b>{shown.name}</b>
        {dead && <span className="pin-sub">Folder no longer exists. Hidden from every list until unpinned.</span>}
        {error && <span className="pin-sub err">{error}</span>}
      </span>
      <span className="pin-age">{lastActiveMs === null ? '' : `${formatAgo(lastActiveMs)} ago`}</span>
      {children}
    </li>
  );
}
