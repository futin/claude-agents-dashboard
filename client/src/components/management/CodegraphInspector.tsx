import { useRef, useState, type KeyboardEvent } from 'react';

import { CODEGRAPH_LEVELS, type CodegraphAssessed, type CodegraphLevel } from '../../lib/codegraphLevels';
import {
  CODEGRAPH_BUILDING_LINE, CODEGRAPH_FOLDER_GONE, CODEGRAPH_KEY_OPEN_FOLDER, CODEGRAPH_LIST_TITLE, CODEGRAPH_NOT_INDEXED, CODEGRAPH_UP_TO_DATE, FACT_CHANGES,
  FACT_LANGUAGES, FACT_LAST_INDEXED, FACT_WATCHER, INSPECTOR_TILES, changesFact, codegraphSteps, codegraphVerdict, formatDbSize, fullCount, indexedAge,
  languagesFact, lastIndexedFact, watcherFact,
} from '../../lib/codegraphText';
import { shortenHome } from '../../lib/pins';
import { CodegraphChips, CodegraphConfirm, CodegraphDot, CodegraphKeys, CodegraphKinds, type CodegraphLayoutProps } from './CodegraphParts';

const LEVEL_LABEL = Object.fromEntries(CODEGRAPH_LEVELS.map(l => [l.key, l.label])) as Record<CodegraphLevel, string>;

/** What a row and the pane say about a repo in one line: the worst verdict, the quiet word, or why there is no graph. */
function whyLine(a: CodegraphAssessed, home: string): string {
  const { repo } = a;
  if (a.level === 'none') return repo.state === 'missing' || repo.path === null ? CODEGRAPH_FOLDER_GONE : CODEGRAPH_NOT_INDEXED(shortenHome(repo.path, home));
  if (a.problems.length > 0) return codegraphVerdict(a.problems[0], repo);
  return repo.state === 'building' ? CODEGRAPH_BUILDING_LINE : CODEGRAPH_UP_TO_DATE;
}

/**
 * Inspector, in Git's shape (the Sessions split): the ranked list beside one repo's graph — size tiles, the symbols-by-kind strip, the facts and the footer
 * keys. The pick falls back to the top-ranked repo when it leaves the list; on a narrow window the pane stacks under the list, so a pick scrolls it into view.
 */
export default function CodegraphInspector(props: CodegraphLayoutProps) {
  const { ranked, nowMs, narrow, home } = props;
  const [pick, setPick] = useState<string | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const cur = ranked.find(x => x.repo.dirName === pick) ?? ranked[0];

  const choose = (dirName: string) => {
    setPick(dirName);
    if (narrow) paneRef.current?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  const onKey = (e: KeyboardEvent, dirName: string) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    choose(dirName);
  };

  return (
    <div className="split git-in">
      <div className="s-card list">
        <div className="list-h"><span className="ct">{CODEGRAPH_LIST_TITLE}</span><span className="proj-pill">{ranked.length}</span></div>
        {ranked.map(a => {
          const { repo, level } = a;
          const selected = repo.dirName === cur?.repo.dirName;
          return (
            <div
              key={repo.dirName}
              className={`lrow${selected ? ' selected' : ''}`}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              onClick={() => choose(repo.dirName)}
              onKeyDown={e => onKey(e, repo.dirName)}
            >
              <CodegraphDot level={level} />
              <span className="nm"><span className="t">{repo.name}</span></span>
              <span className="pct git-age">{repo.state === 'ok' ? indexedAge(repo.stats, nowMs) : '—'}</span>
              <div className="act-line">
                <span className={`spill g-${level}`}>{LEVEL_LABEL[level]}</span>
                <span>·</span>
                <span className={`act${level === 'needs' ? ' hot' : ''}`}>{whyLine(a, home)}</span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="s-card inspect git-in-pane" ref={paneRef}>
        {cur && <Pane a={cur} ctx={props} />}
      </div>
    </div>
  );
}

function Pane({ a, ctx }: { a: CodegraphAssessed; ctx: CodegraphLayoutProps }) {
  const { repo, level, problems } = a;
  const { nowMs, home } = ctx;
  const s = repo.state === 'ok' ? repo.stats : null;
  const steps = problems.flatMap(p => codegraphSteps(p, repo, nowMs).map(text => ({ text, k: `${p.key}:${text}` })));
  const indexed = level !== 'none';

  return (
    <>
      <div className="ins-head">
        <div className="who2">
          <div className="ct">{repo.name}</div>
          <div className="ins-meta">
            <CodegraphDot level={level} />
            <CodegraphChips a={a} upToDate />
            {repo.path !== null && <span className="git-in-path">{shortenHome(repo.path, home)}</span>}
          </div>
        </div>
      </div>
      {(problems.length > 0 || !s) && (
        <div className="cg-pane-why">
          <div className="git-ib-verdict">{whyLine(a, home)}</div>
          {steps.length > 0 && <ul className="git-ib-steps">{steps.map(st => <li key={st.k}>{st.text}</li>)}</ul>}
        </div>
      )}
      {s && (
        <>
          <div className="cg-tiles">
            <div className="cg-tile"><b>{fullCount(s.fileCount)}</b><span>{INSPECTOR_TILES.files}</span></div>
            <div className="cg-tile"><b>{fullCount(s.nodeCount)}</b><span>{INSPECTOR_TILES.symbols}</span></div>
            <div className="cg-tile"><b>{fullCount(s.edgeCount)}</b><span>{INSPECTOR_TILES.edges}</span></div>
            <div className="cg-tile"><b>{formatDbSize(s.dbSizeBytes)}</b><span>{INSPECTOR_TILES.db}</span></div>
          </div>
          <CodegraphKinds stats={s} />
          <dl className="cg-facts">
            <dt>{FACT_LANGUAGES}</dt><dd>{languagesFact(s)}</dd>
            <dt>{FACT_LAST_INDEXED}</dt><dd>{lastIndexedFact(s, nowMs)}</dd>
            <dt>{FACT_CHANGES}</dt><dd>{changesFact(s)}</dd>
            <dt>{FACT_WATCHER}</dt><dd>{watcherFact(repo, nowMs)}</dd>
          </dl>
        </>
      )}
      {(indexed || repo.path !== null) && (
        <div className="cg-foot">
          {indexed && <CodegraphKeys a={a} ctx={ctx} kinds={['sync', 'reindex']} />}
          {repo.path !== null && repo.state !== 'missing' && (
            <button type="button" className="git-key" onClick={() => ctx.openFolder(repo.path!)}>{CODEGRAPH_KEY_OPEN_FOLDER}</button>
          )}
        </div>
      )}
      <CodegraphConfirm a={a} ctx={ctx} align="start" />
    </>
  );
}
