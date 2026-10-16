import { useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';

import Chevron from './Chevron';
import {
  causesOf, clipText, ledTo, subagentType, traceDuration, traceLayout,
  type TraceFilter, type TraceFold, type TraceFolds
} from '../lib/trace';
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
 * Draw the spine's gutter into `svg`. Port of the mock's `drawArcs()`:
 * - a segment between consecutive main-thread dots of one turn;
 * - one lane per agent: down the main spine from its Task dot to the bottom
 *   of the Task's card, an elbow right to the lane, then straight down to the
 *   agent's last rendered child row or fold summary (skipped when that end is
 *   within 12px of the card);
 * - the picked step's cause arcs, solid one hop back, dashed further, each in
 *   its cause row's `--c` (its tick's, when the cause is folded away).
 * A step hidden in a closed fold answers at that fold's toggle; an arc whose
 * two ends land on one toggle is skipped. Only rows on screen have a dot, so
 * a filtered-out step draws nothing.
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
  const mid = (el: Element): [number, number] => {
    const d = el.getBoundingClientRect();
    return [(d.left - box.left + d.width / 2) / scale, (d.top - box.top + d.height / 2) / scale];
  };
  const pos = new Map<string, [number, number]>();
  const rows = new Map<string, HTMLElement>();
  sp.querySelectorAll<HTMLElement>('.tr-row').forEach(r => {
    const dot = r.querySelector('.tr-dot');
    const id = r.dataset.trn;
    if (!dot || !id) return;
    pos.set(id, mid(dot));
    rows.set(id, r);
  });
  // A folded step answers at its summary's toggle. Innermost first: a nested
  // fold follows its outer one in the DOM, and its toggle is the nearer stand-in.
  const sums = [...sp.querySelectorAll<HTMLElement>('.tr-sum')];
  for (const r of sums.reverse()) {
    const dot = r.querySelector('.tr-fold');
    if (!dot) continue;
    const c = mid(dot);
    for (const id of (r.dataset.members ?? '').split(' ')) if (id && !pos.has(id)) pos.set(id, c);
  }
  svg.setAttribute('width', String(sp.offsetWidth));
  svg.setAttribute('height', String(sp.offsetHeight));
  const paths: SVGPathElement[] = [];

  const ids = new Set(steps.map(s => s.id));
  const main = steps.filter(s => pos.has(s.id) && !(s.agent && ids.has(s.agent)));
  for (let i = 1; i < main.length; i++) {
    if (main[i].turn !== main[i - 1].turn) continue;
    const a = pos.get(main[i - 1].id)!, b = pos.get(main[i].id)!;
    paths.push(arc(`M${a[0]} ${a[1]}L${b[0]} ${b[1]}`, 'var(--hairline2)', 2));
  }

  // one lane per agent, ending at its lowest child row or fold summary
  const ends = new Map<string, { x: number; y: number }>();
  sp.querySelectorAll<HTMLElement>('.tr-row[data-agent], .tr-sum.tr-sub').forEach(r => {
    const id = r.dataset.agent || r.dataset.trfold;
    const dot = r.querySelector('.tr-dot');
    if (!id || !dot) return;
    const [x, y] = mid(dot);
    const e = ends.get(id);
    ends.set(id, e ? { x: e.x, y: Math.max(e.y, y) } : { x, y });
  });
  for (const [id, e] of ends) {
    const row = rows.get(id), a = pos.get(id);
    if (!row || !a) continue;
    const yb = (row.getBoundingClientRect().bottom - box.top) / scale;
    if (e.y <= yb + 12) continue;
    const lane = arc(`M${a[0]} ${a[1] + 6}V${yb}C${a[0]} ${yb + 8} ${e.x} ${yb + 2} ${e.x} ${yb + 12}V${e.y}`, 'var(--magenta)', 1.5);
    lane.style.strokeLinecap = 'round';
    paths.push(lane);
  }

  if (sel && pos.has(sel)) {
    for (const [id, m] of anc) {
      const a = pos.get(m.from), b = pos.get(id);
      if (!a || !b) continue;
      if (a[0] === b[0] && a[1] === b[1]) continue; // both ends inside one fold
      const x = Math.min(a[0], b[0]) - Math.min(26, 8 + Math.abs(a[1] - b[1]) / 14);
      const src = rows.get(id) ?? sp.querySelector<HTMLElement>(`.tr-tick[data-trtick="${CSS.escape(id)}"]`);
      const c = (src && getComputedStyle(src).getPropertyValue('--c').trim()) || 'var(--ink3)';
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

/** `--depth` on a nested row, summary or more line: the CSS turns it into the lane's x. */
const depthStyle = (depth: number): CSSProperties | undefined =>
  depth > 0 ? ({ '--depth': depth } as CSSProperties) : undefined;

/**
 * The Trace view's body: one row per tool call, the turn's prompt as a
 * square, a `Turn N` header where a turn starts. Port of the redesign mock's
 * `traceBody()` (docs/guides/mockups/redesign-mock.html); what renders where
 * is `traceLayout`'s call, this only draws its list.
 *
 * A subagent's steps fold into one summary row on its lane, a tick per step,
 * and so do 4+ repeats of one tool on the main thread. The fold's toggle and
 * its ticks are buttons of their own; a tick picks its step and opens the
 * fold. The picked step's causes (`tr-anc`) and what it led to (`tr-desc`)
 * stay at full strength while the rest dim; `focus` dims the rest further.
 * Scrolling more than 80px off the tail while following freezes the pick
 * where it is, which is what `onPick` on the current step means;
 * `↓ Follow live` hands it back.
 */
export function TraceSpine({ steps, sel, filter, focus, follow, folds, dropped, onPick, onFollow, onFold }: {
  steps: TraceStep[];
  sel: string | null;
  filter: TraceFilter;
  focus: boolean;
  follow: boolean;
  folds: TraceFolds;
  /** Steps older than the delivered window, from the response. */
  dropped: number;
  onPick(id: string): void;
  onFollow(): void;
  /** The reader opened (`true`) or closed a fold by hand. */
  onFold(key: string, open: boolean): void;
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
  // Dim (or focus) only around a pick that is on the spine: a `why?` on a chat
  // line older than the loaded steps must not grey out every row.
  const picked = sel != null && seen.current.ids.has(sel);

  const anc = useMemo(() => (sel ? causesOf(steps, sel) : new Map()), [steps, sel]);
  const desc = useMemo(() => new Set(sel ? ledTo(steps, sel).map(s => s.id) : []), [steps, sel]);
  const items = useMemo(() => traceLayout(steps, { filter, sel, folds, dropped }), [steps, filter, sel, folds, dropped]);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [steps, follow, filter]);

  // A pick made off the spine (a Why row, a chat line's `why?`) can sit out
  // of view: bring it to the middle, unless it is already fully readable
  // above the pinned layer. A pick the spine made itself (a row, a tick, or
  // the scroll that stops following) never moves the reader.
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
  useLayoutEffect(() => drawRef.current(), [steps, sel, filter, focus, anc, items]);
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

  function stepRow(s: TraceStep, depth: number): ReactNode {
    const st = s.status;
    const cls = [
      'tr-row', 'tr-k-' + s.kind, depth > 0 ? 'tr-child' : '',
      st === 'running' ? 'tr-run' : st === 'error' ? 'tr-err' : '',
      s.id === sel ? 'tr-on' : '', anc.has(s.id) ? 'tr-anc' : '', desc.has(s.id) ? 'tr-desc' : '',
      fresh.has(s.id) ? 'tr-fresh' : ''
    ].filter(Boolean).join(' ');
    return (
      <div
        className={cls}
        key={s.id}
        style={depthStyle(depth)}
        data-trn={s.id}
        data-agent={depth > 0 ? s.agent : undefined}
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

  function foldRow(key: string, f: TraceFold): ReactNode {
    const n = f.members.length, last = f.members[n - 1];
    const toggle = () => onFold(f.key, !f.open);
    const parts: ReactNode[] = f.task
      ? [
          <b key="t">{subagentType(f.task.tool)}</b>, `${n} steps`, `${f.ok} ok`,
          f.failed > 0 && <span key="e" className="err">{f.failed} failed</span>,
          f.running > 0 && `${f.running} running`,
          traceDuration(f.task.at, last.at) + (f.live ? ' so far' : '')
        ]
      : [
          <b key="t">{f.members[0].tool} ×{n}</b>,
          <span key="p" className="tr-path">{clipText(f.members[0].detail, 36)} → … → {clipText(last.detail, 36)}</span>,
          f.failed > 0 && <span key="e" className="err">{f.failed} failed</span>,
          f.running > 0 && `${f.running} running`
        ];
    const line: ReactNode[] = [];
    parts.filter(Boolean).forEach((x, i) => {
      if (i) line.push(<i key={'s' + i}>·</i>);
      line.push(typeof x === 'string' ? <span key={'x' + i}>{x}</span> : x);
    });
    const holdsAnc = f.ids.some(id => id === sel || anc.has(id));
    const cls = ['tr-sum', 'tr-k-' + (f.task ? 'agent' : f.members[0].kind), f.task ? 'tr-sub' : '', holdsAnc ? 'tr-anc' : '']
      .filter(Boolean).join(' ');
    return (
      <div className={cls} key={key} style={depthStyle(f.depth)} data-trfold={f.key} data-members={f.ids.join(' ')} onClick={toggle}>
        <div className="tr-dotcell">
          <button
            type="button"
            className="tr-dot tr-fold"
            aria-expanded={f.open}
            aria-label={`${f.open ? 'Fold' : 'Unfold'} these ${n} steps`}
            onClick={e => { e.stopPropagation(); toggle(); }}
          >
            <Chevron dir={f.open ? 'down' : 'right'} />
          </button>
        </div>
        <div className="tr-sumcard">
          <div className="tr-sumline">{line}</div>
          <div className="tr-strip" role="group" aria-label="One tick per step">
            {f.members.map(m => (
              <button
                type="button"
                key={m.id}
                className={['tr-tick', 'tr-k-' + m.kind, m.status === 'error' ? 'tr-terr' : '', m.status === 'running' ? 'tr-trun' : '',
                  m.id === sel ? 'tr-on' : ''].filter(Boolean).join(' ')}
                data-trtick={m.id}
                title={`${m.tool} · ${m.detail}`}
                aria-label={`${m.tool} ${m.detail}`}
                aria-pressed={m.id === sel}
                onClick={e => { e.stopPropagation(); onFold(f.key, true); pick(m.id); }}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const rows = items.map((it): ReactNode => {
    switch (it.t) {
      case 'dropped':
        return <div className="tr-more tr-dropped" key={it.key}>{it.n} older steps not loaded</div>;
      case 'turn':
        return <div className="tr-turn" key={it.key}>Turn {it.turn}<span>{it.label}</span></div>;
      case 'step':
        return stepRow(it.step, it.depth);
      case 'fold':
        return foldRow(it.key, it.fold);
      case 'more':
        return (
          <button type="button" className={`tr-more${it.sub ? ' tr-sub' : ''}`} key={it.key} style={depthStyle(it.depth)} onClick={() => onFold(it.fold, true)}>
            {it.n} earlier {it.n === 1 ? 'step' : 'steps'}
          </button>
        );
    }
  });

  return (
    <div className="chat-body tr-body" ref={bodyRef} onScroll={onScroll}>
      <div className={`tr-spine${!picked ? '' : focus ? ' tr-focus' : ' tr-dim'}`} ref={spineRef}>
        {/* the gutter: turn segments, agent lanes and the picked step's cause arcs (`drawArcs`) */}
        <svg className="tr-arcs" aria-hidden="true" ref={arcsRef} />
        {rows}
      </div>
      <button className={`tr-jump${follow ? '' : ' show'}`} onClick={onFollow}>↓ Follow live</button>
    </div>
  );
}
