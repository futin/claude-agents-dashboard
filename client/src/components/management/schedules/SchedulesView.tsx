import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';

import type { ScheduleJobRow, Session } from '../../../../../shared/types';
import { useAnswerToken } from '../../../hooks/useAnswerToken';
import { useNarrow, useShellNarrow } from '../../../hooks/useNarrow';
import { usePins } from '../../../hooks/usePins';
import { useRemoteAnswer } from '../../../hooks/useRemoteAnswer';
import { useScheduleRuns } from '../../../hooks/useScheduleRuns';
import { useScheduleWrite } from '../../../hooks/useScheduleWrite';
import { useSchedules } from '../../../hooks/useSchedules';
import { useSettings } from '../../../hooks/useSettings';
import { deepLinkRun } from '../../../lib/deepLink';
import { chipClass, launchdLabel, reconcileChip, type ScheduleRunsQuery } from '../../../lib/schedules';
import { READ_ONLY_TEXT } from '../../../lib/writeRefusal';
import type { ScheduleCtl } from './ctl';
import JobDrawer from './JobDrawer';
import JobLedger from './JobLedger';
import RunsList from './RunsList';
import StatsBand from './StatsBand';

const ChatDrawer = lazy(() => import('../../ChatDrawer'));

const WINDOWS = [7, 30, 90] as const;
const NEEDS_TOKEN = 'Schedule changes need the Answer token — set it under Settings › Local › Connection.';

type Drawer = { mode: 'new' } | { mode: 'edit'; name: string; confirmDelete: boolean };
type RunFilters = Pick<ScheduleRunsQuery, 'outcome' | 'runner' | 'job'>;

/**
 * Management › Schedules: the job ledger and the run log of the schedules folder (spec §UI). Owns the `/api/schedules` poll, the write helper every
 * control goes through, the drawer and the ChatDrawer a step's `session →` opens. A deep link with `&run=<id>` lands on Runs with that run unfolded.
 */
export default function SchedulesView() {
  const { data, error, refresh } = useSchedules();
  const { settings, update } = useSettings();
  const days = settings.scheduleWindow;
  const [focusRun] = useState(() => deepLinkRun());
  const [page, setPage] = useState<'jobs' | 'runs'>(() => (focusRun ? 'runs' : 'jobs'));
  const [filters, setFilters] = useState<RunFilters>({ outcome: '', runner: '', job: '' });
  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const [chat, setChat] = useState<Session | null>(null);
  const write = useScheduleWrite(refresh);
  const remote = useRemoteAnswer();
  const [token] = useAnswerToken();
  const { pins } = usePins();
  const phone = useShellNarrow();
  const narrow = useNarrow();
  const band = useScheduleRuns({ days, job: '', outcome: '', runner: '' }, page === 'jobs' && data !== null);

  const owner = data?.owner === 'owner';
  const readOnly = remote.state?.writeAccess === 'none';
  const tokenMissing = remote.state?.tokenRequired === true && token === '';
  const lockNote = owner ? (readOnly ? READ_ONLY_TEXT : tokenMissing ? NEEDS_TOKEN : null) : null;

  const { send, setNote } = write;
  const enc = encodeURIComponent;
  const openSession = useCallback((id: string) => {
    void fetch(`/api/sessions/${enc(id)}/row`)
      .then(async res => {
        if (res.status === 404) { setNote({ text: 'That session’s transcript is gone from disk.', tone: 'warn' }); return; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setChat(await res.json() as Session);
      })
      .catch(() => setNote({ text: 'Could not open the session.', tone: 'warn' }));
  }, [setNote]);

  const ctl: ScheduleCtl = {
    now: new Date(),
    machine: data?.machine ?? 'mac',
    dir: data?.dir ?? '',
    owner,
    locked: readOnly || tokenMissing,
    busy: write.busy,
    days,
    phone,
    pins: pins?.pinned ?? [],
    runNow: (name, only) => { void send('Run now', `run:${name}`, 'POST', `/api/schedules/${enc(name)}/run`, only && only.length > 0 ? { only } : {}); },
    stop: name => { void send('Stop', `run:${name}`, 'POST', `/api/schedules/${enc(name)}/stop`); },
    toggle: (name, enabled) => { void send(enabled ? 'Resume' : 'Pause', `toggle:${name}`, 'PATCH', `/api/schedules/${enc(name)}`, { enabled }); },
    openSession,
    edit: (name, confirmDelete = false) => setDrawer({ mode: 'edit', name, confirmDelete }),
    reveal: name => { void send('Reveal', `reveal:${name}`, 'POST', '/api/schedules/reveal', { name }); },
    copyLabel: name => {
      const label = launchdLabel(name);
      void navigator.clipboard?.writeText(label)
        .then(() => setNote({ text: `Copied ${label}`, tone: 'ok' }))
        .catch(() => setNote({ text: `Could not copy; the label is ${label}`, tone: 'warn' }));
    },
    allRuns: name => { setFilters({ outcome: '', runner: '', job: name }); setPage('runs'); }
  };

  const chip = data ? reconcileChip(data) : null;
  const names = useMemo(() => (data?.jobs ?? []).map(j => j.name), [data]);
  const editRow: ScheduleJobRow | null = drawer?.mode === 'edit' ? data?.jobs.find(j => j.name === drawer.name) ?? null : null;

  // A drawer left open on a job deleted elsewhere has nothing to save into; the next poll closes it.
  useEffect(() => {
    if (drawer?.mode === 'edit' && data && !data.jobs.some(j => j.name === drawer.name)) setDrawer(null);
  }, [data, drawer]);

  return (
    <div className="usage-section sch-view">
      <div className="mgmt-bar">
        <div className="mgmt-title sch-title">
          <span>{narrow ? 'Schedules' : 'Management · Schedules'}</span>
          {data && <span className="git-chip sch-mach sch-here">{data.machine}</span>}
        </div>
        {!phone && data && (
          <div className="mgmt-sub">
            Jobs defined in <code>{data.dir}</code>, run by {data.machine === 'mac' ? 'launchd' : 'cron'} on this machine. Files sync through git; each
            machine installs only the jobs that name it.
          </div>
        )}
      </div>
      <div className="git-toolbar">
        <div className="seg" role="tablist" aria-label="Page">
          {(['jobs', 'runs'] as const).map(p => (
            <button key={p} type="button" role="tab" aria-selected={page === p} className={page === p ? 'on' : ''} onClick={() => setPage(p)}>
              {p === 'jobs' ? 'Jobs' : 'Runs'}
            </button>
          ))}
        </div>
        <div className="seg sch-sm" role="group" aria-label="Window">
          {WINDOWS.map(w => (
            <button key={w} type="button" aria-pressed={days === w} className={days === w ? 'on' : ''} onClick={() => update({ scheduleWindow: w })}>
              {w}d
            </button>
          ))}
        </div>
        {page === 'runs' && (
          <>
            <div className="seg sch-sm" role="group" aria-label="Outcome">
              {([['', 'All'], ['failed', 'Failed'], ['lost', 'Lost']] as const).map(([v, label]) => (
                <button key={v} type="button" aria-pressed={filters.outcome === v} className={filters.outcome === v ? 'on' : ''} onClick={() => setFilters(f => ({ ...f, outcome: v }))}>
                  {label}
                </button>
              ))}
            </div>
            <div className="seg sch-sm sch-hide" role="group" aria-label="Runner">
              {([['', 'Any'], ['claude', 'claude'], ['shell', 'shell']] as const).map(([v, label]) => (
                <button key={v} type="button" aria-pressed={filters.runner === v} className={filters.runner === v ? 'on' : ''} onClick={() => setFilters(f => ({ ...f, runner: v }))}>
                  {label}
                </button>
              ))}
            </div>
            <select className="sch-select" aria-label="Job" value={filters.job} onChange={e => setFilters(f => ({ ...f, job: e.target.value }))}>
              <option value="">job: any</option>
              {names.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </>
        )}
        {page === 'jobs' && chip && <span className={`${chipClass(chip.tone)} sch-hide`}>{chip.text}</span>}
        {page === 'jobs' && owner && (
          <span className="sch-tools">
            <button type="button" className="sch-btn sch-hide" disabled={ctl.locked || write.busy === 'reconcile'}
              onClick={() => { void send('Reconcile', 'reconcile', 'POST', '/api/schedules/reconcile', { apply: true }); }}>
              Reconcile
            </button>
            <button type="button" className="sch-btn sch-primary" disabled={ctl.locked} onClick={() => setDrawer({ mode: 'new' })}>
              {phone ? 'New' : 'New job'}
            </button>
          </span>
        )}
      </div>
      {page === 'jobs' && chip && phone && <div><span className={chipClass(chip.tone)}>{chip.text}</span></div>}
      {lockNote && <div className="git-sync-note">{lockNote}</div>}
      {write.note && write.note.text !== lockNote && (
        <div className={write.note.tone === 'warn' ? 'git-sync-note' : 'git-quick-note'} role="status">{write.note.text}</div>
      )}
      {owner && data?.reconcile.error && <div className="git-sync-note">Reconcile: {data.reconcile.error}</div>}
      {data === null ? (
        <div className="git-empty">{error ? 'Couldn’t load the schedules.' : 'Loading schedules…'}</div>
      ) : page === 'jobs' ? (
        <>
          <StatsBand data={band.data} days={days} jobs={data.jobs} />
          <JobLedger rows={data.jobs} ctl={ctl} />
        </>
      ) : (
        <RunsList query={{ days, ...filters }} rows={data.jobs} ctl={ctl} focusRun={focusRun} />
      )}
      {drawer && data && (drawer.mode === 'new' || editRow) && (
        <JobDrawer
          key={drawer.mode === 'new' ? 'new' : drawer.name}
          mode={drawer.mode}
          row={editRow}
          confirmDelete={drawer.mode === 'edit' && drawer.confirmDelete}
          existing={names}
          ctl={ctl}
          send={send}
          onClose={() => setDrawer(null)}
        />
      )}
      {chat && (
        <Suspense fallback={null}>
          <ChatDrawer key={chat.id} session={chat} onClose={() => setChat(null)} spawnAvailable={remote.state?.spawnAvailable === true} />
        </Suspense>
      )}
    </div>
  );
}

