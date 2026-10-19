import { useCallback, useMemo, useState } from 'react';

import type { CodegraphResponse } from '../../../../shared/types';
import { useAnswerToken } from '../../hooks/useAnswerToken';
import { useCodegraph } from '../../hooks/useCodegraph';
import { useCodegraphRun } from '../../hooks/useCodegraphRun';
import { useNarrow } from '../../hooks/useNarrow';
import { useOpenFolder } from '../../hooks/useOpenFolder';
import { usePersistedState } from '../../hooks/usePersistedState';
import { usePins } from '../../hooks/usePins';
import { useSettings } from '../../hooks/useSettings';
import { DEFAULT_CODEGRAPH_LAYOUT, codegraphLayoutsFor, drawableCodegraphLayout, parseCodegraphLayout, type CodegraphLayout } from '../../lib/codegraphLayouts';
import { rankCodegraphRepos } from '../../lib/codegraphLevels';
import {
  CODEGRAPH_BAND_SUB, CODEGRAPH_BAND_TITLE, CODEGRAPH_CLI_MISSING, CODEGRAPH_NEEDS_TOKEN, CODEGRAPH_NO_PINS, CODEGRAPH_NO_PINS_LINK, codegraphFirstLoadText,
} from '../../lib/codegraphText';
import { READ_ONLY_TEXT } from '../../lib/writeRefusal';
import { Band } from '../usage/Sheet';
import CodegraphClockChip from './CodegraphClockChip';
import CodegraphInbox from './CodegraphInbox';
import CodegraphInspector from './CodegraphInspector';
import CodegraphMatrix from './CodegraphMatrix';
import type { CodegraphLayoutProps } from './CodegraphParts';

/**
 * Management › CodeGraph: the band, a toolbar of the Inbox | Matrix | Inspector switcher and the READ / WATCHERS clock chip, and the layout the switcher picks.
 * The poll lives in `useCodegraph`, mounted with this view, so leaving the tab stops it. Ranking happens once here, per payload, so every layout and the chip
 * agree about every repo. `cli: 'missing'` draws the toolbar and one sentence: the server then marks every indexed repo `error`, which would be noise.
 *
 * The stored layout is per device (`management.codegraphLayout`); a phone draws Inbox while a stored Matrix waits for the next wide window.
 */
export default function CodegraphView() {
  const cg = useCodegraph();
  const { data, error } = cg;
  const runCtl = useCodegraphRun(cg.refresh);
  const [token] = useAnswerToken();
  const tokenMissing = runCtl.tokenRequired === true && token === '';
  const readOnly = runCtl.writeAccess === 'none';
  const narrow = useNarrow();
  const [stored, setStored] = usePersistedState<string>('management.codegraphLayout', DEFAULT_CODEGRAPH_LAYOUT);
  const layout = drawableCodegraphLayout(parseCodegraphLayout(stored), narrow);
  const { pins } = usePins();
  const folder = useOpenFolder();
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const cancel = useCallback(() => setConfirmFor(null), []);

  const ranked = useMemo(() => (data !== null && data.cli === 'ok' ? rankCodegraphRepos(data.repos) : []), [data]);
  const anyIndexed = ranked.some(a => a.level !== 'none');
  // A key that cannot work says why once, here, rather than failing on each click.
  const lockNote = !anyIndexed ? null : readOnly ? READ_ONLY_TEXT : tokenMissing ? CODEGRAPH_NEEDS_TOKEN : null;

  const props: CodegraphLayoutProps = {
    ranked, nowMs: Date.now(), home: pins?.home ?? '', runCtl, keysLocked: readOnly || tokenMissing,
    confirm: { dirName: confirmFor, ask: setConfirmFor, cancel }, openFolder: folder.open, narrow,
  };

  return (
    <div className="usage-section git-view">
      <Band title={CODEGRAPH_BAND_TITLE} sub={CODEGRAPH_BAND_SUB} />
      <div className="git-toolbar">
        <div className="seg git-switch" role="tablist" aria-label="Layout">
          {codegraphLayoutsFor(narrow).map(l => (
            <button key={l.key} type="button" role="tab" aria-selected={layout === l.key} className={layout === l.key ? 'on' : ''} onClick={() => setStored(l.key)}>
              {l.label}
            </button>
          ))}
        </div>
        {(data !== null || error) && <CodegraphClockChip cg={cg} ranked={ranked} runCtl={runCtl} tokenMissing={tokenMissing} writeAccess={runCtl.writeAccess} />}
      </div>
      {lockNote && <div className="git-sync-note">{lockNote}</div>}
      {runCtl.note && runCtl.note !== lockNote && <div className="git-sync-note">{runCtl.note}</div>}
      {folder.note && <div className="git-sync-note">{folder.note}</div>}
      <CodegraphBody data={data} error={error} layout={layout} props={props} />
    </div>
  );
}

function CodegraphBody({ data, error, layout, props }: { data: CodegraphResponse | null; error: boolean; layout: CodegraphLayout; props: CodegraphLayoutProps }) {
  const { update } = useSettings();
  if (data === null) return <div className="git-empty">{codegraphFirstLoadText(error)}</div>;
  if (data.cli === 'missing') return <div className="git-empty">{CODEGRAPH_CLI_MISSING}</div>;
  if (data.repos.length === 0) {
    // The last "Projects" of Git's sentence becomes the link to the Projects sub-view; the rest stays the copy's text.
    const at = CODEGRAPH_NO_PINS.lastIndexOf(CODEGRAPH_NO_PINS_LINK);
    return (
      <div className="git-empty">
        {CODEGRAPH_NO_PINS.slice(0, at)}
        <button type="button" className="git-link" onClick={() => update({ managementTab: 'projects' })}>{CODEGRAPH_NO_PINS_LINK}</button>
        {CODEGRAPH_NO_PINS.slice(at + CODEGRAPH_NO_PINS_LINK.length)}
      </div>
    );
  }
  if (layout === 'matrix') return <CodegraphMatrix {...props} />;
  if (layout === 'inspector') return <CodegraphInspector {...props} />;
  return <CodegraphInbox {...props} />;
}
