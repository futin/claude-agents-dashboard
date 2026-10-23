import { useState } from 'react';

import { CODEGRAPH_LEVELS, type CodegraphAssessed, type CodegraphLevel } from '../../lib/codegraphLevels';
import { CODEGRAPH_FILTER_EMPTY, CODEGRAPH_FOLDER_GONE, CODEGRAPH_NOT_INDEXED, codegraphQuietLine, codegraphSteps, codegraphVerdict } from '../../lib/codegraphText';
import { shortenHome } from '../../lib/pins';
import { CodegraphChips, CodegraphConfirm, CodegraphDot, CodegraphKeys, type CodegraphLayoutProps } from './CodegraphParts';

const LEVEL_LABEL = Object.fromEntries(CODEGRAPH_LEVELS.map(l => [l.key, l.label])) as Record<CodegraphLevel, string>;

/**
 * Inbox, in Git's shape: four count tiles that filter (a second click clears), the loud repos as panels with a verdict, every problem's steps and their
 * keys, then *All good* as one dashed box of lines and *Not indexed* as a second one, which has no key — indexing is the user's call (spec §Non-goals).
 */
export default function CodegraphInbox(props: CodegraphLayoutProps) {
  const { ranked, nowMs, home } = props;
  const [filter, setFilter] = useState<CodegraphLevel | 'all'>('all');
  const show = (l: CodegraphLevel) => filter === 'all' || filter === l;

  const loud = ranked.filter(a => (a.level === 'needs' || a.level === 'look') && show(a.level));
  const quiet = ranked.filter(a => a.level === 'quiet' && show('quiet'));
  const none = ranked.filter(a => a.level === 'none' && show('none'));

  return (
    <>
      <div className="git-ib-sum">
        {CODEGRAPH_LEVELS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className={`git-ib-tile ${key}${filter === key ? ' on' : ''}`}
            aria-pressed={filter === key}
            onClick={() => setFilter(filter === key ? 'all' : key)}
          >
            <span className="big">{ranked.filter(a => a.level === key).length}</span>
            <span className="lab"><CodegraphDot level={key} />{label}</span>
          </button>
        ))}
      </div>
      {loud.length > 0 && (
        <div className="git-ib-list">
          {loud.map(a => <InboxItem key={a.repo.dirName} a={a} ctx={props} />)}
        </div>
      )}
      {quiet.length > 0 && (
        <>
          <div className="git-gh">{LEVEL_LABEL.quiet}</div>
          <div className="git-ib-quiet">
            {quiet.map(a => (
              <div key={a.repo.dirName} className="git-ib-line">
                <CodegraphDot level="quiet" />
                <span className="git-name">{a.repo.name}</span>
                <span className="git-ib-facts">{codegraphQuietLine(a.repo, nowMs)}</span>
                <CodegraphKeys a={a} ctx={props} />
              </div>
            ))}
          </div>
        </>
      )}
      {none.length > 0 && (
        <>
          <div className="git-gh">{LEVEL_LABEL.none}</div>
          <div className="git-ib-quiet">
            {none.map(a => (
              <div key={a.repo.dirName} className="git-ib-line">
                <CodegraphDot level="none" />
                <span className="git-name">{a.repo.name}</span>
                <span className="git-ib-facts">
                  {a.repo.state === 'missing' || a.repo.path === null ? CODEGRAPH_FOLDER_GONE : CODEGRAPH_NOT_INDEXED(shortenHome(a.repo.path, home))}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      {loud.length + quiet.length + none.length === 0 && filter !== 'all' && <div className="git-empty">{CODEGRAPH_FILTER_EMPTY}</div>}
    </>
  );
}

/** A loud repo: the worst problem's verdict leads, and every problem's steps follow it (spec §Levels). */
function InboxItem({ a, ctx }: { a: CodegraphAssessed; ctx: CodegraphLayoutProps }) {
  const { repo, problems } = a;
  const steps = problems.flatMap(p => codegraphSteps(p, repo, ctx.nowMs).map(text => ({ text, k: `${p.key}:${text}` })));
  return (
    <article className="git-panel git-ib-item">
      <div className="git-ib-top">
        <CodegraphDot level={a.level} />
        <div className="git-ib-main">
          <div className="git-head">
            <span className="git-name">{repo.name}</span>
            <CodegraphChips a={a} />
          </div>
          <div className="git-ib-verdict">{codegraphVerdict(problems[0], repo)}</div>
          {steps.length > 0 && (
            <ul className="git-ib-steps">
              {steps.map(s => <li key={s.k}>{s.text}</li>)}
            </ul>
          )}
        </div>
        <div className="git-ib-keys"><CodegraphKeys a={a} ctx={ctx} /></div>
      </div>
      <CodegraphConfirm a={a} ctx={ctx} />
    </article>
  );
}
