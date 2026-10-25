import { useState } from 'react';

import { bandLine, checkSegments, checksRow, endedLine, mergeRow, reviewRow, stateLabel, type PrRow } from '../lib/pr';
import { formatAgo } from '../lib/format';
import type { SessionPr, SessionPrLive } from '../../../shared/types';
import Chevron from './Chevron';

const ago = (iso: string): string => formatAgo(Date.parse(iso));

function Pill({ state }: { state: SessionPrLive['state'] }) {
  return <span className={`pr-state ${state}`}>{stateLabel(state)}</span>;
}

/** The pull-request glyph from the mockup: two commits on a branch, merging back. */
function Glyph() {
  return (
    <svg className="pr-glyph" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.8" /><circle cx="4" cy="12.5" r="1.8" /><circle cx="12" cy="12.5" r="1.8" />
      <path d="M4 5.3v5.4M12 10.7V6.5a2 2 0 0 0-2-2H7.5M9 3l-1.5 1.5L9 6" />
    </svg>
  );
}

function Row({ k, row }: { k: string; row: PrRow }) {
  return <div className="pr-row">{k} <b className={row.tone}>{row.text}</b></div>;
}

/**
 * The PR this session created, in the chat sidecar. One DOM for both widths, the `TasksCard` pattern: on desktop the head, title and rows always show and
 * the band is hidden; on a phone the band is the folded line and `.folded` hides the rows.
 */
export function PrCard({ pr }: { pr: SessionPr }) {
  const [folded, setFolded] = useState(true);
  if (!pr) return null;
  const live = pr.live;
  const ended = live && (live.state === 'merged' || live.state === 'closed');

  return (
    <div className={`kv pr-kv${folded ? ' folded' : ''}`}>
      <div className="pr-top">
        <span className="k"><Glyph />PR #{pr.number}</span>
        {live && <Pill state={live.state} />}
      </div>
      <a className="pr-title" href={pr.url} target="_blank" rel="noopener noreferrer">{pr.title ?? '—'}</a>
      <div className="pr-ref">{live ? `${live.head} → ${live.base}` : pr.repo}</div>
      <button type="button" className="pr-band" aria-expanded={!folded} onClick={() => setFolded(f => !f)}>
        <span className="k">PR</span>
        <span className="n">#{pr.number}</span>
        {live && <Pill state={live.state} />}
        <span className="line">{bandLine(pr, ago)}</span>
        <span className="cue"><Chevron dir={folded ? 'down' : 'up'} /></span>
      </button>
      <div className="pr-rows">
        {!live && <Row k="Status" row={{ text: `unavailable · ${pr.unavailable ?? 'gh failed'}`, tone: 'dim' }} />}
        {live && ended && <div className="pr-row pr-ended">{endedLine(live, ago)}</div>}
        {live && !ended && (
          <>
            <Row k="Checks" row={checksRow(live.checks)} />
            {live.checks && (
              <div className="pr-checks" aria-hidden="true">
                {checkSegments(live.checks).map((tone, i) => <i key={i} className={tone} />)}
              </div>
            )}
            <Row k="Review" row={reviewRow(live.review)} />
            <Row k="Merge" row={mergeRow(live.merge, live.base)} />
          </>
        )}
      </div>
    </div>
  );
}
