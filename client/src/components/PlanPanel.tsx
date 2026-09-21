import { useEffect, useId, useMemo, useState } from 'react';

import { Markdown } from './Markdown';
import { parseInline, type Inline } from '../lib/markdown';
import { MinimisedPanel, PanelHead } from './PanelChrome';
import { collapsedSummary } from '../lib/panelCollapse';
import type { PendingPlanState } from '../hooks/usePendingPlan';

/** Same shape `lib/markdown.ts` accepts for an ATX heading, so the two agree. */
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
/** A fence opener/closer, so a `#` inside a code block is never mistaken for one. */
const FENCE_RE = /^\s*(```+|~~~+)/;

/** The words of an inline tree, with its markup spent rather than printed. */
function inlineText(nodes: Inline[]): string {
  return nodes.map(n => (n.t === 'text' || n.t === 'code' ? n.v : inlineText(n.kids))).join('');
}

/**
 * The header prints the title as plain text, so a heading carrying inline
 * markdown would show its own syntax: `## Redesign the **board**` reading as
 * `Redesign the **board**`. Take the words and spend the marks.
 *
 * Derived from **`parseInline` itself**, not from a second set of patterns
 * here: the title then says exactly what the body renders, by construction,
 * and the two cannot drift. That matters most where `markdown.ts` deliberately
 * does NOT render something — `__init__` and `snake_case` keep their
 * underscores, `2 * 3 * 4` its asterisks — because a hand-rolled strip would
 * quietly make the title say less than the heading did.
 */
function plainTitle(text: string): string {
  const plain = inlineText(parseInline(text)).trim();
  // Markers with nothing between them (`****`) parse as literal text, since
  // there is no run to emphasise. A heading made of nothing else has no words
  // to show, so it is not a title — the same rule as a bare `#`.
  return plain.replace(/[*_`~]/g, '').trim() === '' ? '' : plain;
}

/**
 * The plan's title is the plan's **own first heading**, and the body is the
 * plan with that heading taken out — never a second label typed here, which
 * would drift from it, and never the heading printed twice.
 *
 * Falls back to a generic kicker only for a plan that has no heading at all;
 * there is nothing to drift from in that case.
 */
export function splitPlan(md: string): { title: string; body: string } {
  const lines = md.split('\n');
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) { fenced = !fenced; continue; }
    if (fenced) continue;
    const h = HEADING_RE.exec(lines[i]);
    const title = h ? plainTitle(h[2]) : '';
    // A heading that is nothing but markup (`## ****`) has no words to show, so
    // it is not a title — same rule as a bare `#`.
    if (!title) continue;
    const rest = lines.slice(0, i).concat(lines.slice(i + 1)).join('\n');
    return { title, body: rest.replace(/^\n+/, '') };
  }
  return { title: 'proposed plan', body: md };
}

/**
 * The action bar for a plan a session is waiting on. Type what to change and
 * send it back; the model revises and proposes again. "Decide on the card"
 * releases the hook instead, so the plan card appears in the terminal within a
 * second.
 *
 * ⚠️ No approve button, and unlike `PermissionBanner` this is not a policy
 * choice we made: the CLI drops a hook `allow` for tools that declare
 * `requiresUserInteraction()`, and `ExitPlanMode` is one — its card *is* the
 * approval surface. An approve button here would be a lie.
 *
 * ⚠️ And no `show plan` button either. It was shaped like an option row, so it
 * read as an answer — and once the panel floats over the transcript it hid the
 * only copy of the plan the reader could reach. The plan is the panel's
 * subject, so it is a titled block that always shows its opening lines, clipped
 * under a fade, and the whole clipped box is the control that opens it
 * (`.claude/DESIGN.md` §8.6). Expanded it takes no cap of its own: the panel
 * grows with it up to the top of the transcript area, and the panel — not the
 * plan — is what scrolls from there.
 *
 * Fed by the plan store (the markdown from the hook's stdin), so it works even
 * before the `tool_use` record reaches the transcript the drawer renders.
 */
export default function PlanPanel({ state }: { state: PendingPlanState }) {
  const { pending, phase, needsToken, reject, dismiss, setToken } = state;
  const [feedback, setFeedback] = useState('');
  const [tokenDraft, setTokenDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [minimised, setMinimised] = useState(false);
  const planBoxId = useId();
  const { title, body } = useMemo(() => splitPlan(pending?.plan ?? ''), [pending?.plan]);

  // A revised plan (or a fresh drawer) starts from a clean slate — expanded
  // included, so a re-proposed plan is never hidden behind an old stub.
  const planId = pending?.planId ?? null;
  useEffect(() => {
    setFeedback('');
    setOpen(false);
    setMinimised(false);
  }, [planId]);

  if (phase === 'gone') {
    return (
      <div className="qpanel gone">
        <span className="qp-note">That plan was decided in the terminal, or it expired.</span>
      </div>
    );
  }

  // Checked before `pending`: the poll can take up to 3s to notice the wait is
  // over, and until then the form must not re-offer a send that would just 404.
  if (phase === 'sent') {
    return (
      <div className="qpanel sent">
        <span className="qp-note">✓ Sent back for revision · the session is re-planning</span>
      </div>
    );
  }

  if (!pending) return null;

  if (minimised) {
    return (
      <MinimisedPanel
        badge="plan proposed"
        summary={collapsedSummary({ kind: 'plan' })}
        tone="plan"
        onExpand={() => setMinimised(false)}
      />
    );
  }

  const busy = phase === 'submitting';

  return (
    <div className="qpanel plan">
      <PanelHead
        badge="plan proposed"
        hint="approve on the card · revise from here"
        onMinimise={() => setMinimised(true)}
      />

      <div className="qp-planblock">
        <div className="qp-planhead">
          <span className="qp-kick">plan</span>
          {/* the plan's own first heading — never a second label to drift from it */}
          <span className="qp-plantitle" title={title}>{title}</span>
          <button
            type="button"
            className="qp-fold"
            aria-expanded={open}
            aria-controls={planBoxId}
            onClick={() => setOpen(o => !o)}
          >
            {open ? 'collapse' : 'read all'}
            <span className="cv" aria-hidden="true">{open ? '▴' : '▾'}</span>
          </button>
        </div>
        {/* A div rather than a <button>: a plan's markdown carries links, and an
            <a> inside a <button> is both invalid and unreachable. The click
            guards let a link, and a drag-select inside an open plan, win over
            the fold — collapsing the thing you were mid-sentence in is the one
            way "the whole box is the control" turns hostile. */}
        <div
          id={planBoxId}
          className={`qp-plan${open ? '' : ' clip'}`}
          role="button"
          tabIndex={0}
          aria-expanded={open}
          aria-label={open ? 'Collapse the plan' : 'Read the whole plan'}
          onClick={e => {
            if ((e.target as HTMLElement).closest('a')) return;
            if (window.getSelection()?.toString()) return;
            setOpen(o => !o);
          }}
          onKeyDown={e => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            // The same link guard the click handler carries, for the same
            // reason: Enter on a focused link inside the plan must follow the
            // link, not preventDefault it and fold the box under the reader.
            if ((e.target as HTMLElement).closest('a')) return;
            e.preventDefault();
            setOpen(o => !o);
          }}
        >
          <div className="cmsg-text">
            <Markdown text={body} />
          </div>
        </div>
      </div>

      {needsToken && (
        <div className="qp-token">
          <span className="qp-note">This dashboard needs its answer token.</span>
          <input
            className="qp-other"
            type="password"
            placeholder="ANSWER_TOKEN"
            value={tokenDraft}
            onChange={e => setTokenDraft(e.target.value)}
          />
          <button type="button" className="qp-send" onClick={() => setToken(tokenDraft.trim())}>
            save
          </button>
        </div>
      )}

      <textarea
        className="qp-feedback"
        maxLength={2000}
        rows={3}
        placeholder="What should change? (sent to the model verbatim)"
        value={feedback}
        disabled={busy}
        onChange={e => setFeedback(e.target.value)}
      />

      <div className="qp-actions">
        <button
          type="button"
          className="qp-send"
          disabled={busy || !feedback.trim()}
          onClick={() => void reject(feedback)}
        >
          {busy ? 'sending…' : 'send back for revision'}
        </button>
        <button type="button" className="qp-term" disabled={busy} onClick={() => void dismiss()}>
          decide on the card
        </button>
      </div>
    </div>
  );
}
