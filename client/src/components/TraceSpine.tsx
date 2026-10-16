import { useLayoutEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react';

import { causesOf, ledTo, passesFilter, turnLabel, type TraceFilter } from '../lib/trace';
import type { TraceStep } from '../../../shared/types';

/** Distance from the bottom (px) past which a scroll stops following the live tail (the mock's figure). */
const UNFOLLOW_SLACK = 80;

/** Ids present now that were not in the previous delivery. A first load or a reset (no id survives) has none. */
function arrivals(prev: Set<string>, ids: Set<string>): Set<string> {
  const fresh = new Set<string>();
  if (!prev.size) return fresh;
  let kept = false;
  for (const id of ids) {
    if (prev.has(id)) kept = true;
    else fresh.add(id);
  }
  return kept ? fresh : new Set();
}

/**
 * The Trace view's body: one row per tool call, the turn's prompt as a
 * square, a `Turn N` header where a turn starts. Port of the redesign mock's
 * `traceBody()` (docs/guides/mockups/redesign-mock.html).
 *
 * The picked step's causes (`tr-anc`) and what it led to (`tr-desc`) stay at
 * full strength while the rest dim; `focus` dims the rest further. The picked
 * row renders even when the filter would drop it. Scrolling more than 80px off
 * the tail while following freezes the pick where it is, which is what
 * `onPick` on the current step means; `↓ Follow live` hands it back.
 */
export function TraceSpine({ steps, sel, filter, focus, follow, onPick, onFollow }: {
  steps: TraceStep[];
  sel: string | null;
  filter: TraceFilter;
  focus: boolean;
  follow: boolean;
  onPick(id: string): void;
  onFollow(): void;
}): JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null);

  // `tr-fresh`: the ids that first appeared in the latest delivery. Recomputed
  // only when `steps` is a new array, so a re-render for a pick keeps it.
  const seen = useRef<{ steps: TraceStep[] | null; ids: Set<string>; fresh: Set<string> }>({
    steps: null, ids: new Set(), fresh: new Set()
  });
  if (seen.current.steps !== steps) {
    const ids = new Set(steps.map(s => s.id));
    seen.current = { steps, ids, fresh: arrivals(seen.current.ids, ids) };
  }
  const fresh = seen.current.fresh;

  const anc = useMemo(() => (sel ? causesOf(steps, sel) : new Map()), [steps, sel]);
  const desc = useMemo(() => new Set(sel ? ledTo(steps, sel).map(s => s.id) : []), [steps, sel]);
  const labels = useMemo(() => {
    const m = new Map<number, string>();
    for (const s of steps) if (!m.has(s.turn)) m.set(s.turn, turnLabel(steps, s.turn));
    return m;
  }, [steps]);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [steps, follow, filter]);

  function onScroll() {
    const el = bodyRef.current;
    if (!el || !follow || !sel) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight > UNFOLLOW_SLACK) onPick(sel);
  }

  function onKey(e: KeyboardEvent, id: string) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onPick(id);
  }

  const rows: ReactNode[] = [];
  let turn = 0;
  for (const s of steps) {
    if (!passesFilter(s, filter) && s.id !== sel) continue;
    if (s.turn !== turn) {
      turn = s.turn;
      rows.push(<div className="tr-turn" key={'h-' + s.id}>Turn {turn}<span>{labels.get(turn)}</span></div>);
    }
    const st = s.status;
    const cls = [
      'tr-row', 'tr-k-' + s.kind, s.agent ? 'tr-child' : '',
      st === 'running' ? 'tr-run' : st === 'error' ? 'tr-err' : '',
      s.id === sel ? 'tr-on' : '', anc.has(s.id) ? 'tr-anc' : '', desc.has(s.id) ? 'tr-desc' : '',
      fresh.has(s.id) ? 'tr-fresh' : ''
    ].filter(Boolean).join(' ');
    rows.push(
      <div
        className={cls}
        key={s.id}
        tabIndex={0}
        role="button"
        aria-pressed={s.id === sel}
        onClick={() => onPick(s.id)}
        onKeyDown={e => onKey(e, s.id)}
      >
        <div className="tr-dotcell"><span className="tr-dot" /></div>
        <div className="tr-card">
          <div className="tr-line">
            <span className="tr-tool">{s.tool}</span>
            <span className="tr-detail">{s.detail}</span>
            {st === 'running' && <span className="tr-flag run">{s.kind === 'decide' ? 'waiting on you' : 'running'}</span>}
            {st === 'error' && <span className="tr-flag err">failed</span>}
            {s.answer && st !== 'running' && <span className="tr-flag you" title={s.answer}>{s.answer}</span>}
            {s.sha && st !== 'running' && <span className="tr-flag sha">{s.sha}</span>}
            {s.thinking === 'text' && <span className="tr-flag think">thinking</span>}
          </div>
          {s.intent && <div className="tr-intent">{s.intent}</div>}
          {s.kind !== 'prompt' && (
            <div className="tr-res">{st === 'running' ? 'waiting for its result…' : '→ ' + (s.result || s.answer || '')}</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="chat-body tr-body" ref={bodyRef} onScroll={onScroll}>
      <div className={`tr-spine${focus ? ' tr-focus' : sel ? ' tr-dim' : ''}`}>
        {/* the picked step's cause arcs draw into this, in the spine's left gutter */}
        <svg className="tr-arcs" aria-hidden="true" />
        {rows}
      </div>
      <button className={`tr-jump${follow ? '' : ' show'}`} onClick={onFollow}>↓ Follow live</button>
    </div>
  );
}
