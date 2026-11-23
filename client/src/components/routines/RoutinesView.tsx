import { Suspense, lazy, useCallback, useMemo, useRef, useState } from 'react';

import type { RoutineJobRow, Session } from '../../../../shared/types';
import { useAnswerToken } from '../../hooks/useAnswerToken';
import { useNarrow, useShellNarrow } from '../../hooks/useNarrow';
import { usePins } from '../../hooks/usePins';
import { useRemoteAnswer } from '../../hooks/useRemoteAnswer';
import { useRoutineRuns } from '../../hooks/useRoutineRuns';
import { useRoutineWrite } from '../../hooks/useRoutineWrite';
import { useRoutines } from '../../hooks/useRoutines';
import { useSettings } from '../../hooks/useSettings';
import { deepLinkRun } from '../../lib/deepLink';
import { chipClass, jobsSubtitle, launchdLabel, reconcileChip, reconcilePreview, type ReconcilePreview } from '../../lib/routines';
import type { RoutineRunFilters } from '../../lib/settings';
import { READ_ONLY_TEXT } from '../../lib/writeRefusal';
import { LoadBoundary } from '../LoadBoundary';
import type { RoutineCtl } from './ctl';
import JobDrawer from './JobDrawer';
import JobLedger from './JobLedger';
import RunsList from './RunsList';
import StatsBand from './StatsBand';

const ChatDrawer = lazy(() => import('../ChatDrawer'));

const WINDOWS = [7, 30, 90] as const;
const NEEDS_TOKEN = 'Routine changes need the Answer token — set it under Settings › Local › Connection.';

type Drawer = { mode: 'new' } | { mode: 'edit'; name: string; confirmDelete: boolean };

/**
 * The Routines section: the job ledger (Jobs) and the run log (Runs) of the routines folder (spec §UI). Owns the `/api/routines` poll, the write helper every
 * control goes through, the drawer and the ChatDrawer a step's `session →` opens. A deep link with `&run=<id>` lands on Runs with that run unfolded.
 */
export default function RoutinesView() {
  const { data, error, refresh } = useRoutines();
  const { settings, update } = useSettings();
  const days = settings.routineWindow;
  const [focusRun] = useState(() => deepLinkRun());
  // Jobs or Runs is picked in the rail's tree (`routinesTab`); `AppShell` puts a `&run=` link on Runs.
  const page = settings.routinesTab;
  // Per device in settings, beside the window, so a reload keeps them.
  const filters = settings.routineRunFilters;
  const setFilters = (next: Partial<RoutineRunFilters>): void => update({ routineRunFilters: { ...filters, ...next } });
  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const [chat, setChat] = useState<Session | null>(null);
  const [plan, setPlan] = useState<ReconcilePreview | null>(null);
  const write = useRoutineWrite(refresh);
  const remote = useRemoteAnswer();
  const [token] = useAnswerToken();
  const { pins } = usePins();
  const phone = useShellNarrow();
  const narrow = useNarrow();
  const band = useRoutineRuns({ days, job: '', outcome: '', runner: '' }, page === 'jobs' && data !== null);

  const pageLabel = page === 'jobs' ? 'Jobs' : 'Runs';
  const owner = data?.owner === 'owner';
  const readOnly = remote.state?.writeAccess === 'none';
  const tokenMissing = remote.state?.tokenRequired === true && token === '';
  const lockNote = owner ? (readOnly ? READ_ONLY_TEXT : tokenMissing ? NEEDS_TOKEN : null) : null;

  const { send, setNote } = write;
  const enc = encodeURIComponent;
  // The failure is shown beside the link that was clicked, not in the page note: a Runs row far down the list would put that note off screen.
  const openSession = useCallback(async (id: string): Promise<string | null> => {
    try {
      const res = await fetch(`/api/sessions/${enc(id)}/row`);
      if (res.status === 404) return 'session transcript not found';
      if (!res.ok) return 'could not open the session';
      setChat(await res.json() as Session);
      return null;
    } catch {
      return 'could not open the session';
    }
  }, []);

  const ctl: RoutineCtl = {
    now: new Date(),
    machine: data?.machine ?? 'mac',
    dir: data?.dir ?? '',
    owner,
    locked: readOnly || tokenMissing,
    busy: write.busy,
    days,
    phone,
    pins: pins?.pinned ?? [],
    runNow: (name, only) => { void send('Run now', `run:${name}`, 'POST', `/api/routines/${enc(name)}/run`, only !== undefined ? { only } : {}); },
    stop: name => { void send('Stop', `run:${name}`, 'POST', `/api/routines/${enc(name)}/stop`); },
    toggle: (name, enabled) => { void send(enabled ? 'Resume' : 'Pause', `toggle:${name}`, 'PATCH', `/api/routines/${enc(name)}`, { enabled }); },
    openSession,
    edit: (name, confirmDelete = false) => setDrawer({ mode: 'edit', name, confirmDelete }),
    reveal: name => { void send('Reveal', `reveal:${name}`, 'POST', '/api/routines/reveal', { name }); },
    copyLabel: name => {
      const label = launchdLabel(name);
      void navigator.clipboard?.writeText(label)
        .then(() => setNote({ text: `Copied ${label}`, tone: 'ok' }))
        .catch(() => setNote({ text: `Could not copy; the label is ${label}`, tone: 'warn' }));
    },
    allRuns: name => { update({ routineRunFilters: { outcome: '', runner: '', job: name }, routinesTab: 'runs' }); }
  };

  // Reconcile can boot jobs out, so the first click only plans (no `apply`) and shows the diff; Apply re-plans on the server and applies (spec §Reconcile).
  const previewReconcile = async (): Promise<void> => {
    const r = await send('Reconcile', 'reconcile', 'POST', '/api/routines/reconcile', {});
    setPlan(r.ok ? reconcilePreview(r.body) : null);
  };
  const applyPlan = async (): Promise<void> => {
    const r = await send('Reconcile', 'reconcile', 'POST', '/api/routines/reconcile', { apply: true });
    if (r.ok) setPlan(null);
  };

  const chip = data ? reconcileChip(data) : null;
  const names = useMemo(() => (data?.jobs ?? []).map(j => j.name), [data]);
  const editRow: RoutineJobRow | null = drawer?.mode === 'edit' ? data?.jobs.find(j => j.name === drawer.name) ?? null : null;

  // A poll can lack an open drawer's job (renamed or deleted elsewhere). The drawer stays mounted on the last row it saw, `gone`, and decides itself:
  // closed when clean, kept open with Save off when it holds unsaved edits.
  const lastRow = useRef<RoutineJobRow | null>(null);
  if (editRow) lastRow.current = editRow;
  const shownRow = editRow ?? (drawer?.mode === 'edit' && lastRow.current?.name === drawer.name ? lastRow.current : null);
  const gone = drawer?.mode === 'edit' && editRow === null;

  return (
    <div className="usage-section rtn-view">
      <div className="mgmt-bar">
        <div className="mgmt-title rtn-title">
          <span>{narrow ? pageLabel : `Routines · ${pageLabel}`}</span>
          {data && <span className="git-chip rtn-mach rtn-here">{data.machine}</span>}
        </div>
        {!phone && data && (
          <div className="mgmt-sub">
            {jobsSubtitle(data.dir, data.machine)}
          </div>
        )}
      </div>
      <div className="git-toolbar">
        <div className="seg rtn-sm" role="group" aria-label="Window">
          {WINDOWS.map(w => (
            <button key={w} type="button" aria-pressed={days === w} className={days === w ? 'on' : ''} onClick={() => update({ routineWindow: w })}>
              {w}d
            </button>
          ))}
        </div>
        {page === 'runs' && (
          <>
            <div className="seg rtn-sm" role="group" aria-label="Outcome">
              {([['', 'All'], ['failed', 'Failed'], ['lost', 'Lost']] as const).map(([v, label]) => (
                <button key={v} type="button" aria-pressed={filters.outcome === v} className={filters.outcome === v ? 'on' : ''} onClick={() => setFilters({ outcome: v })}>
                  {label}
                </button>
              ))}
            </div>
            <div className="seg rtn-sm" role="group" aria-label="Runner">
              {([['', 'Any'], ['claude', 'claude'], ['shell', 'shell']] as const).map(([v, label]) => (
                <button key={v} type="button" aria-pressed={filters.runner === v} className={filters.runner === v ? 'on' : ''} onClick={() => setFilters({ runner: v })}>
                  {label}
                </button>
              ))}
            </div>
            <select className="rtn-select" aria-label="Job" value={filters.job} onChange={e => setFilters({ job: e.target.value })}>
              <option value="">job: any</option>
              {/* A persisted job whose file is gone still filters; without its own option the select would read "job: any" over a filtered list. */}
              {filters.job !== '' && !names.includes(filters.job) && <option value={filters.job}>{filters.job} (no job file)</option>}
              {names.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </>
        )}
        {page === 'jobs' && chip && <span className={chipClass(chip.tone)}>{chip.text}</span>}
        {page === 'jobs' && owner && (
          <span className="rtn-tools">
            <button type="button" className="rtn-btn" disabled={ctl.locked || write.busy.has('reconcile')}
              onClick={() => { void previewReconcile(); }}>
              Reconcile
            </button>
            <button type="button" className="rtn-btn rtn-primary" disabled={ctl.locked} onClick={() => setDrawer({ mode: 'new' })}>
              {phone ? 'New' : 'New job'}
            </button>
          </span>
        )}
      </div>
      {page === 'jobs' && owner && plan && (
        <div className="rtn-plan" role="status">
          <div className="rtn-plan-sum">Reconcile plan: {plan.summary}</div>
          {plan.rows.length > 0 && (
            <ul className="rtn-plan-list">
              {plan.rows.map(r => (
                <li key={r.key} className="rtn-plan-row">
                  <span className="rtn-plan-act">{r.action}</span>
                  <span className="rtn-plan-name">{r.name}</span>
                  {r.why && <span className="rtn-plan-why">{r.why}</span>}
                </li>
              ))}
            </ul>
          )}
          {plan.error && <div className="rtn-plan-err">{plan.error}</div>}
          <div className="rtn-plan-btns">
            <button type="button" className="rtn-btn rtn-sm rtn-primary" disabled={ctl.locked || !plan.canApply || write.busy.has('reconcile')}
              onClick={() => { void applyPlan(); }}>
              Apply
            </button>
            <button type="button" className="rtn-btn rtn-sm" onClick={() => setPlan(null)}>Cancel</button>
          </div>
        </div>
      )}
      {lockNote && <div className="git-sync-note">{lockNote}</div>}
      {write.note && write.note.text !== lockNote && (
        <div className={write.note.tone === 'warn' ? 'git-sync-note' : 'git-quick-note'} role="status">{write.note.text}</div>
      )}
      {owner && data?.reconcile.error && <div className="git-sync-note">Reconcile: {data.reconcile.error}</div>}
      {data === null ? (
        <div className="git-empty">{error ? 'Couldn’t load the routines.' : 'Loading routines…'}</div>
      ) : page === 'jobs' ? (
        <>
          <StatsBand data={band.data} days={days} jobs={data.jobs} />
          <JobLedger rows={data.jobs} ctl={ctl} />
        </>
      ) : (
        <RunsList query={{ days, ...filters }} rows={data.jobs} ctl={ctl} focusRun={focusRun}
          onClearFilters={() => update({ routineRunFilters: { outcome: '', runner: '', job: '' } })} />
      )}
      {drawer && data && (drawer.mode === 'new' || shownRow) && (
        <JobDrawer
          key={drawer.mode === 'new' ? 'new' : drawer.name}
          mode={drawer.mode}
          row={shownRow}
          gone={gone}
          confirmDelete={drawer.mode === 'edit' && drawer.confirmDelete}
          existing={names}
          ctl={ctl}
          send={send}
          onClose={() => setDrawer(null)}
        />
      )}
      {chat && (
        <LoadBoundary variant="float">
          <Suspense fallback={null}>
            <ChatDrawer key={chat.id} session={chat} onClose={() => setChat(null)} spawnAvailable={remote.state?.spawnAvailable === true} desktopAvailable={remote.state?.desktopAvailable === true} />
          </Suspense>
        </LoadBoundary>
      )}
    </div>
  );
}

