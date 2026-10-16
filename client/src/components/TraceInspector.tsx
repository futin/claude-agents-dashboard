import { useMemo } from 'react';

import { causesOf, ledTo, REL_FWD_LABEL, REL_LABEL, turnLabel } from '../lib/trace';
import type { TraceStep } from '../../../shared/types';

/** A Why / Led to row's detail is cut here, the ellipsis counting toward it (the mock's figure). */
const ROW_DETAIL_CAP = 64;

const SIGNATURE_TITLE = 'Recorded as an encrypted signature; the text is not in the transcript';

const pad = (n: number) => String(n).padStart(2, '0');

/** Local `HH:MM:SS` of an ISO timestamp; `—` when it doesn't parse (a step's `at` can be `''`). */
function clock(at: string): string {
  const d = new Date(at);
  if (!at || Number.isNaN(d.getTime())) return '—';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const cut = (s: string) => (s.length > ROW_DETAIL_CAP ? s.slice(0, ROW_DETAIL_CAP - 1) + '…' : s);

function Row({ step, label, near, onPick }: { step: TraceStep; label: string; near: boolean; onPick(id: string): void }) {
  return (
    <li className={`tr-k-${step.kind}${near ? ' near' : ''}`}>
      <button type="button" onClick={() => onPick(step.id)}>
        <span className="g" aria-hidden="true"><i /></span>
        <span className="tsub">
          <span className="tr-rel">{label}</span>
          <span className="tr-tool">{step.tool}</span>
          {cut(step.detail)}
        </span>
      </button>
    </li>
  );
}

/**
 * The Trace view's sidecar, under the Context card: one card in the Tasks
 * card's place — the picked step read in full, its causes nearest first, then
 * what it led to — and the step's own fields as facts under it, where Chat
 * lists the session's. Port of the redesign mock's `inspector()`
 * (docs/guides/mockups/redesign-mock.html).
 *
 * `questionPending` is whether the drawer's question panel is showing its
 * options, so a running decide step can point at it.
 */
export function TraceInspector({ steps, sel, questionPending, onPick }: {
  steps: TraceStep[];
  sel: string | null;
  questionPending: boolean;
  onPick(id: string): void;
}): JSX.Element {
  const idx = useMemo(() => {
    const m = new Map<string, number>();
    steps.forEach((s, i) => m.set(s.id, i));
    return m;
  }, [steps]);
  const s = sel != null && idx.has(sel) ? steps[idx.get(sel)!] : null;

  const chain = useMemo(
    () => (s ? [...causesOf(steps, s.id).entries()].sort((a, b) => a[1].d - b[1].d || idx.get(a[0])! - idx.get(b[0])!) : []),
    [steps, s, idx]
  );
  const led = useMemo(() => (s ? ledTo(steps, s.id) : []), [steps, s]);

  if (!s) {
    return (
      <div className="kv tasks-kv tr-one">
        <div className="tr-none">Pick a step to see why it happened.</div>
      </div>
    );
  }

  const st = s.status;
  const res = s.result || s.answer || '';
  const outcome = s.kind === 'prompt' ? null
    : st === 'running' ? (
      <div className="tr-stat">
        {s.kind === 'decide'
          ? (questionPending ? 'Waiting for your answer — it is in the panel below' : 'Waiting for your answer')
          : 'Waiting for its tool_result…'}
      </div>
    )
    : st === 'error' ? <div className="tr-stat err">✕ {res}</div>
    : s.answer ? <div className="tr-stat you">You answered <b>{s.answer}</b></div>
    : <div className="tr-stat ok">✓ {res}{s.sha ? ' · ' + s.sha : ''}</div>;

  const statusFact = s.kind === 'prompt' ? 'prompt'
    : st === 'running' ? (s.kind === 'decide' ? 'waiting on you' : 'running')
    : st === 'error' ? 'failed' : 'ok';
  const from = s.intentFrom === 'description' ? 'call description' : s.intentFrom === 'text' ? "Claude's text" : '—';
  const thinking = s.thinking === 'text' ? 'readable' : s.thinking === 'signature' ? 'signature only' : 'none';
  const label = turnLabel(steps, s.turn);
  const turn = label ? `${s.turn} · ${label}` : String(s.turn);

  return (
    <>
      <div className={`kv tasks-kv tr-one tr-k-${s.kind}`}>
        <div className="k">
          <span className="tr-tool">{s.tool}</span>
          <span>{chain.length} {chain.length === 1 ? 'cause' : 'causes'}</span>
        </div>
        <div className={`tr-title${s.kind === 'prompt' || s.kind === 'decide' ? ' prose' : ''}`}>{s.detail}</div>
        {s.intent && <div className="tr-say">{s.intent}</div>}
        {outcome}
        {s.thinking === 'text' && (
          <div className="tr-think"><span className="lbl">Thinking</span>{s.thinkingText ?? ''}</div>
        )}
        <ol className="task-list">
          <li className="tr-led">Why</li>
          {chain.length
            ? chain.map(([id, m]) => (
              <Row key={'w-' + id} step={steps[idx.get(id)!]} label={REL_LABEL[m.rel]} near={m.d === 1} onPick={onPick} />
            ))
            : <li className="tr-nil">A prompt is where a turn starts; nothing comes before it.</li>}
          {led.length > 0 && (
            <>
              <li className="tr-led">Led to</li>
              {led.map(a => (
                <Row key={'l-' + a.id} step={a} label={REL_FWD_LABEL[a.why.find(w => w.id === s.id)!.rel]} near onPick={onPick} />
              ))}
            </>
          )}
        </ol>
      </div>
      {/* At, Intent from and Thinking are phone-hidden (`.f.wide`, as Chat's
          facts): the band keeps Status, Turn and Plan task, the spine the rest. */}
      <div className="chat-facts">
        <div className="f"><span>Status</span><b>{statusFact}</b></div>
        <div className="f"><span>Turn</span><b title={turn}>{turn}</b></div>
        <div className="f wide"><span>At</span><b>{clock(s.at)}</b></div>
        <div className="f"><span>Plan task</span><b title={s.task}>{s.task || '—'}</b></div>
        <div className="f wide"><span>Intent from</span><b>{from}</b></div>
        <div className="f wide"><span>Thinking</span><b title={s.thinking === 'signature' ? SIGNATURE_TITLE : undefined}>{thinking}</b></div>
      </div>
    </>
  );
}
