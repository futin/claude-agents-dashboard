import { useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react';

import { causesOf, ledTo, passesFilter, turnLabel, type TraceFilter } from '../lib/trace';
import type { TraceStep } from '../../../shared/types';

/** Distance from the bottom (px) past which a scroll stops following the live tail (the mock's figure). */
const UNFOLLOW_SLACK = 80;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** One `<path>` for the arcs layer. Strokes go through `style`, so a `var(--token)` resolves the way it does in CSS. */
function arc(d: string, stroke: string, width: number, extra?: { dash?: string; opacity?: number }): SVGPathElement {
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', d);
  p.style.fill = 'none';
  p.style.stroke = stroke;
  p.style.strokeWidth = String(width);
  if (extra?.dash) p.style.strokeDasharray = extra.dash;
  if (extra?.opacity != null) p.style.opacity = String(extra.opacity);
  return p;
}

/**
 * Draw the spine's gutter into `svg`: a segment between consecutive main-scope
 * dots of one turn, a magenta curve from each subagent step's dispatching Task
 * dot, and the picked step's cause arcs — solid one hop back, dashed further,
 * each in its cause row's own `--c`. Port of the mock's `drawArcs()`. Only
 * rows on screen have a dot, so a filtered-out step draws nothing.
 *
 * Positions are measured as rects and divided back by the rect/layout ratio:
 * `.shell{zoom}` scales the rect but not the box the SVG is drawn in.
 */
function drawArcs(
  sp: HTMLElement, svg: SVGSVGElement, steps: TraceStep[], sel: string | null,
  anc: Map<string, { d: number; from: string }>
): void {
  const box = sp.getBoundingClientRect();
  const scale = sp.offsetWidth ? box.width / sp.offsetWidth : 1;
  const pos = new Map<string, [number, number]>();
  const rows = new Map<string, HTMLElement>();
  sp.querySelectorAll<HTMLElement>('.tr-row').forEach(r => {
    const dot = r.querySelector('.tr-dot');
    const id = r.dataset.trn;
    if (!dot || !id) return;
    const d = dot.getBoundingClientRect();
    pos.set(id, [(d.left - box.left + d.width / 2) / scale, (d.top - box.top + d.height / 2) / scale]);
    rows.set(id, r);
  });
  svg.setAttribute('width', String(sp.offsetWidth));
  svg.setAttribute('height', String(sp.offsetHeight));
  const paths: SVGPathElement[] = [];

  const main = steps.filter(s => pos.has(s.id) && !s.agent);
  for (let i = 1; i < main.length; i++) {
    if (main[i].turn !== main[i - 1].turn) continue;
    const a = pos.get(main[i - 1].id)!, b = pos.get(main[i].id)!;
    paths.push(arc(`M${a[0]} ${a[1]}L${b[0]} ${b[1]}`, 'var(--hairline2)', 2));
  }
  for (const s of steps) {
    if (!s.agent) continue;
    const a = pos.get(s.agent), b = pos.get(s.id);
    if (!a || !b) continue;
    paths.push(arc(`M${a[0]} ${a[1]}C${a[0]} ${b[1] - 6} ${a[0] + 4} ${b[1]} ${b[0]} ${b[1]}`, 'var(--magenta)', 1.5, { opacity: 0.55 }));
  }
  if (sel && pos.has(sel)) {
    for (const [id, m] of anc) {
      const a = pos.get(m.from), b = pos.get(id), row = rows.get(id);
      if (!a || !b || !row) continue;
      const x = Math.min(a[0], b[0]) - Math.min(26, 8 + Math.abs(a[1] - b[1]) / 14);
      const c = getComputedStyle(row).getPropertyValue('--c').trim() || 'var(--ink3)';
      const d = `M${a[0] - 6} ${a[1]}C${x} ${a[1]} ${x} ${b[1]} ${b[0] - 6} ${b[1]}`;
      paths.push(m.d === 1 ? arc(d, c, 2) : arc(d, c, 1.3, { dash: '4 4', opacity: 0.7 }));
    }
  }
  svg.replaceChildren(...paths);
}

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
  const spineRef = useRef<HTMLDivElement>(null);
  const arcsRef = useRef<SVGSVGElement>(null);

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

  // A pick made off the spine (a Why row, a chat line's `why?`) can sit out
  // of view: bring it to the middle, unless it is already fully readable
  // above the pinned layer. A pick the spine made itself (a row, or the
  // scroll that stops following) never moves the reader.
  const ownPick = useRef<string | null>(null);
  function pick(id: string) {
    ownPick.current = id;
    onPick(id);
  }
  useLayoutEffect(() => {
    const own = ownPick.current === sel;
    ownPick.current = null;
    const body = bodyRef.current, sp = spineRef.current;
    if (own || follow || !sel || !body || !sp) return;
    const row = [...sp.querySelectorAll<HTMLElement>('.tr-row')].find(r => r.dataset.trn === sel);
    if (!row) return;
    const top = sp.offsetTop + row.offsetTop, bottom = top + row.offsetHeight;
    const covered = parseFloat(getComputedStyle(body).getPropertyValue('--pinned-h')) || 0;
    if (top >= body.scrollTop && bottom <= body.scrollTop + body.clientHeight - covered) return;
    body.scrollTop = top - (body.clientHeight - covered - row.offsetHeight) / 2;
  }, [sel, follow]);

  // The gutter redraws on everything that moves a dot or changes what is
  // picked, and on a resize of the spine (rows re-wrap, the modal resizes).
  const drawRef = useRef(() => {});
  drawRef.current = () => {
    if (spineRef.current && arcsRef.current) drawArcs(spineRef.current, arcsRef.current, steps, sel, anc);
  };
  useLayoutEffect(() => drawRef.current(), [steps, sel, filter, focus, anc]);
  useEffect(() => {
    const sp = spineRef.current;
    if (!sp) return;
    const ro = new ResizeObserver(() => drawRef.current());
    ro.observe(sp);
    return () => ro.disconnect();
  }, []);

  function onScroll() {
    const el = bodyRef.current;
    if (!el || !follow || !sel) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight > UNFOLLOW_SLACK) pick(sel);
  }

  function onKey(e: KeyboardEvent, id: string) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    pick(id);
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
        data-trn={s.id}
        tabIndex={0}
        role="button"
        aria-pressed={s.id === sel}
        onClick={() => pick(s.id)}
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
      <div className={`tr-spine${focus ? ' tr-focus' : sel ? ' tr-dim' : ''}`} ref={spineRef}>
        {/* the gutter: turn segments, subagent curves and the picked step's cause arcs (`drawArcs`) */}
        <svg className="tr-arcs" aria-hidden="true" ref={arcsRef} />
        {rows}
      </div>
      <button className={`tr-jump${follow ? '' : ' show'}`} onClick={onFollow}>↓ Follow live</button>
    </div>
  );
}
