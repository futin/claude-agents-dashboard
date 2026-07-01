import type { SessionsResponse } from '../../../shared/types';

/** Title bar + summary line (generated time, active count, running claude procs). */
export function Header({ data }: { data: SessionsResponse | null }) {
  const meta = data ? new Date(data.generatedAt).toLocaleTimeString() : '';

  let sub: React.ReactNode = '';
  if (data) {
    const procs = data.runningClaudeProcs == null
      ? ''
      : ` · ${data.runningClaudeProcs} claude proc${data.runningClaudeProcs === 1 ? '' : 's'}`;
    sub = <><b>{data.totals.active}</b>{` active · top ${data.maxSessions}${procs}`}</>;
  }

  return (
    <>
      <div className="head">
        <h1>⚡ Claude Sessions</h1>
        <span className="meta">{meta}</span>
      </div>
      <div className="sub">{sub}</div>
    </>
  );
}
