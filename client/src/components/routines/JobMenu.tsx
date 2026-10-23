import type { RoutineJobRow } from '../../../../shared/types';
import { isFanOut } from '../../lib/routines';
import type { RoutineCtl } from './ctl';

/**
 * The caret menu: everything that is not Run now (spec §UI, screen 5). A non-owner gets only what needs no write — the file, read-only, and the launchd
 * label. Below 1024 px the row has no Run now button, so the menu leads with it there.
 */
export default function JobMenu({ row, ctl, onClose, onRunOne }: { row: RoutineJobRow; ctl: RoutineCtl; onClose(): void; onRunOne(): void }) {
  const job = row.job;
  const runnable = ctl.owner && row.onThisMachine && job !== null;
  const fanOut = job !== null && (job.foreach !== null || (row.last !== null && isFanOut(row.last)));
  const busy = ctl.busy === `run:${row.name}`;
  const pick = (fn: () => void) => () => { onClose(); fn(); };
  const mac = ctl.machine === 'mac';

  return (
    <div className="rtn-menu" role="menu" aria-label={`${row.name} actions`}>
      {runnable && (row.running
        ? <button type="button" role="menuitem" className="rtn-phone" disabled={ctl.locked || busy} onClick={pick(() => ctl.stop(row.name))}>Stop</button>
        : <button type="button" role="menuitem" className="rtn-phone" disabled={ctl.locked || busy} onClick={pick(() => ctl.runNow(row.name))}>Run now</button>)}
      <button type="button" role="menuitem" onClick={pick(() => ctl.edit(row.name))}>{ctl.owner ? 'Edit file' : 'View file'}</button>
      {runnable && fanOut && !row.running && (
        <button type="button" role="menuitem" disabled={ctl.locked || busy} onClick={onRunOne}>Run now on one repo…</button>
      )}
      {ctl.owner && job && (
        <button type="button" role="menuitem" disabled={ctl.locked || ctl.busy === `toggle:${row.name}`} onClick={pick(() => ctl.toggle(row.name, !job.enabled))}>{job.enabled ? 'Pause' : 'Resume'}</button>
      )}
      {ctl.owner && mac && <button type="button" role="menuitem" disabled={ctl.locked} onClick={pick(() => ctl.reveal(row.name))}>Reveal in Finder</button>}
      {mac && <button type="button" role="menuitem" onClick={pick(() => ctl.copyLabel(row.name))}>Copy launchd label</button>}
      {ctl.owner && (
        <>
          <div className="rtn-sep" role="separator" />
          <button type="button" role="menuitem" className="rtn-danger" disabled={ctl.locked} onClick={pick(() => ctl.edit(row.name, true))}>Delete…</button>
        </>
      )}
    </div>
  );
}
