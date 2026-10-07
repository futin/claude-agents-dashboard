import { useLayoutEffect, useRef, useState } from 'react';

import { planName, scrollTargetId, taskLine, taskProgress } from '../lib/tasks';
import type { SessionTask } from '../../../shared/types';

const GLYPH = { done: '✓', todo: '○' } as const;

function kindOf(t: SessionTask): 'done' | 'live' | 'todo' {
  return t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'live' : 'todo';
}

/**
 * One DOM for both widths: on a phone the sidecar is a band and `.folded` hides the list, on desktop the stylesheet shows the list regardless and hides
 * the folded line, so the head row and the folded line each carry `done/total` for exactly one width (docs spec §4.2).
 */
export function TasksCard({ tasks, plan }: { tasks: SessionTask[] | null; plan: string | null }) {
  const p = taskProgress(tasks);
  const [folded, setFolded] = useState(true);
  const listRef = useRef<HTMLOListElement>(null);
  // Once per drawer instance: a reader scrolling the list must not be pulled back by the next 3s poll.
  const scrolled = useRef(false);
  const targetId = p ? scrollTargetId(p) : null;

  useLayoutEffect(() => {
    const list = listRef.current;
    if (scrolled.current || targetId === null || !list) return;
    // A display:none list has no geometry and ignores scrollTop, so a folded phone defers the scroll to the first unfold rather than spending it.
    if (list.clientHeight === 0) return;
    const li = Array.from(list.children).find(c => (c as HTMLElement).dataset.taskId === targetId) as HTMLElement | undefined;
    if (!li) return;
    // scrollTop, not scrollIntoView: that one scrolls every ancestor, and here it would drag the drawer and the page.
    list.scrollTop = li.offsetTop - (list.clientHeight - li.offsetHeight) / 2;
    scrolled.current = true;
  }, [targetId, folded]);

  if (!p) return null;
  const line = taskLine(p);
  const status = p.allDone ? '✓ All tasks done' : p.done === 0 && p.live.length === 0 ? 'Not started' : null;

  return (
    <div className={`kv tasks-kv${folded ? ' folded' : ''}`}>
      <div className="k">
        <span title={plan ?? undefined}>{plan === null ? 'Tasks' : `Plan · ${planName(plan)}`}</span>
        <span>{p.done} / {p.total}</span>
      </div>
      <button type="button" className="task-fold" aria-expanded={!folded} onClick={() => setFolded(f => !f)}>
        <span className="tf-k">{plan === null ? 'Tasks' : 'Plan'}</span>
        <span className="tf-n">{p.done}/{p.total}</span>
        <span className={`tf-line ${line.kind}`}>{line.text}</span>
        <span className="tf-cue">{folded ? '▾' : '▴'} list</span>
      </button>
      <div className="track">
        <div className={`fill${p.allDone ? ' done' : ''}`} style={{ width: `${p.pct}%` }} />
      </div>
      {status && <div className={`task-status${p.allDone ? '' : ' idle'}`}>{status}</div>}
      <ol className="task-list" ref={listRef}>
        {(tasks ?? []).map(t => {
          const kind = kindOf(t);
          return (
            <li key={t.id} className={kind} data-task-id={t.id} aria-current={kind === 'live' ? 'step' : undefined}>
              <span className="g" aria-hidden="true">{kind === 'live' ? <span className="task-dot" /> : GLYPH[kind]}</span>
              <span className="tsub">{t.subject}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
