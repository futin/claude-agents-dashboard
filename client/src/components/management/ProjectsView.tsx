import { useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { usePinReorder } from '../../hooks/usePinReorder';
import { usePins } from '../../hooks/usePins';
import { usePersistedState } from '../../hooks/usePersistedState';
import { formatAgo } from '../../lib/format';
import {
  DEFAULT_PROJECTS_LAYOUT, LIST_SUB_OFFERS, LIST_SUB_PINNED, PROJECTS_BAND_SUB, PROJECTS_GONE_CHIP, PROJECTS_LAYOUTS, PROJECTS_MISSING,
  isProjectsLayout, noOffersText, noPinsText, projectDir, splitProjects, type ProjectsLayout,
} from '../../lib/projectsView';
import { SettingsBand, SettingsGroup, SettingsRow } from '../settings/SettingsRow';
import type { PinRow, ProjectRef } from '../../../../shared/types';

/** One project as every layout draws it: a stored pin (`on`) or an offer, with the dir already `~`-shortened. */
interface Item {
  dirName: string;
  name: string;
  dir: string;
  lastActiveMs: number | null;
  on: boolean;
  /** A dead pin: stored, but its folder is gone, so every other list hides it. */
  gone: boolean;
  error: string | null;
  label: string;
  disabled: boolean;
  onClick: () => void;
  /** A pin's lead column: its grip, or the empty cell holding the grip's place while the filter hides it. Undefined for an offer, which has none. */
  grip?: ReactNode;
  /** The pin being dragged: it dims in its slot until release. */
  src: boolean;
  /** A pin's element, whose box the drop rule reads. */
  ref?: (el: HTMLElement | null) => void;
}

const NO_PINS: PinRow[] = [];

/**
 * Management › Projects: the band, a toolbar of the Tiles | Columns | Lists switcher and one filter box, then the stored pins and the projects on offer
 * in the shape the switcher picks. The pin ledger used to be a PinPicker in a Settings card; it is now the page's own content, on the app ground.
 *
 * Grouping, the filter match, the dir line and every string come from `lib/projectsView.ts`. A click never moves a project by hand: `usePins` answers with
 * the fresh payload and the groups re-split from it. A refusal shows inline under that project and changes nothing. Enter in the filter pins the first
 * offered match and clears the box, as in the launch sheet's picker.
 *
 * Every Pinned project, in all three layouts, leads with a grip (`usePinReorder`, pin-reorder spec §4.3): drag it, or ↑/← and ↓/→ on it focused, and the
 * new order saves, flashing `Saved` beside the Pinned count. The drag is a drop line (redesign spec §3): nothing moves until release, the source dims,
 * a bar marks the gap and the Pinned head reads `Moving <name> · <n> of <N>`. A filtered list has gaps, so while the filter is non-blank each pin keeps an
 * empty cell in the grip's place and nothing can be dragged.
 *
 * A dead pin's note is the `Folder gone` chip's tooltip, not a line under its dir, so every tile keeps one height.
 */
export default function ProjectsView() {
  const { pins, busy, setPin, reorder } = usePins();
  const [stored, setStored] = usePersistedState<string>('management.projectsLayout', DEFAULT_PROJECTS_LAYOUT);
  const layout: ProjectsLayout = isProjectsLayout(stored) ? stored : DEFAULT_PROJECTS_LAYOUT;
  const [query, setQuery] = useState('');
  const [error, setError] = useState<{ dirName: string; text: string } | null>(null);
  const filterBlank = query.trim() === '';
  // The gap the drop line centres in: Lists rows abut, Tiles and Columns sit 6px apart.
  const moves = usePinReorder(pins?.pinned ?? NO_PINS, busy, reorder, filterBlank, layout === 'lists' ? 0 : 6);

  async function act(dirName: string, pinned: boolean, clearQuery: boolean): Promise<void> {
    if (busy) return;
    moves.cancel();
    setError(null);
    const text = await setPin(dirName, pinned);
    if (text) setError({ dirName, text });
    else if (clearQuery) setQuery('');
  }

  const band = <SettingsBand scope="shared" title="Management · Projects" sub={PROJECTS_BAND_SUB} />;
  if (pins === null) {
    return (
      <div className="usage-section pj-view">
        {band}
        <div className="git-empty">Loading…</div>
      </div>
    );
  }

  const { pinned, offers, pinnedShown, offersShown } = splitProjects(pins, query);
  const item = (r: PinRow | ProjectRef, on: boolean): Item => ({
    dirName: r.dirName,
    name: r.name,
    dir: r.path === null ? '' : projectDir(r.path, pins.home),
    lastActiveMs: r.lastActiveMs,
    on,
    gone: on && (r as PinRow).listed === false,
    error: error?.dirName === r.dirName ? error.text : moves.errorFor(r.dirName),
    label: busy === r.dirName ? (on ? 'Unpinning…' : 'Pinning…') : (on ? 'Unpin' : 'Pin'),
    disabled: busy !== null,
    onClick: () => void act(r.dirName, !on, !on),
    grip: !on ? undefined : filterBlank
      ? <button type="button" className="pin-grip" {...moves.grip(r.dirName)}>⠿</button>
      : <span aria-hidden="true" />,
    src: moves.dragging === r.dirName,
    ref: on ? moves.rowRef(r.dirName) : undefined,
  });
  const pinItems = pinnedShown.map(r => item(r, true));
  const offerItems = offersShown.map(r => item(r, false));
  const noPins = <div className="pin-note">{noPinsText(pinned.length)}</div>;
  const noOffers = <div className="pin-note">{noOffersText(offers.length)}</div>;
  const saved = moves.headLabel
    ? <span className="pin-saved live" role="status">{moves.headLabel}</span>
    : moves.headError
    ? <span className="pin-saved err" role="status">{moves.headError}</span>
    : <span className={moves.saved ? 'pin-saved' : 'pin-saved off'} role="status" aria-hidden={!moves.saved}>Saved</span>;
  const pinGroup = <TileGroup title="Pinned" total={pinned.length} items={pinItems} empty={noPins} aside={saved} />;
  const offerGroup = <TileGroup title="Not pinned" total={offers.length} items={offerItems} empty={noOffers} />;

  let body: ReactNode;
  if (layout === 'lists') {
    body = (
      <div className="pj-cols">
        <ListCard title="Not pinned" total={offers.length} items={offerItems} sub={LIST_SUB_OFFERS} empty={noOffers} />
        <ListCard title="Pinned" total={pinned.length} items={pinItems} sub={LIST_SUB_PINNED} empty={noPins} aside={saved} />
      </div>
    );
  } else if (layout === 'columns') {
    // Not pinned on the left, Pinned on the right: Pin carries a project straight across.
    body = <div className="pj-cols"><section>{offerGroup}</section><section>{pinGroup}</section></div>;
  } else {
    body = <>{pinGroup}{offerGroup}</>;
  }

  return (
    <div className="usage-section pj-view">
      {band}
      <div className="git-toolbar pj-toolbar">
        <div className="seg" role="tablist" aria-label="Layout">
          {PROJECTS_LAYOUTS.map(l => (
            <button key={l.key} type="button" role="tab" aria-selected={layout === l.key} className={layout === l.key ? 'on' : ''} onClick={() => setStored(l.key)}>
              {l.label}
            </button>
          ))}
        </div>
        <input
          className="pin-filter"
          type="text"
          placeholder="Filter by name or path"
          aria-label="Filter projects"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && offersShown.length > 0) {
              e.preventDefault();
              void act(offersShown[0].dirName, true, true);
            }
          }}
        />
      </div>
      <div>{body}</div>
      {/* On body, outside `.shell`: its zoom would scale a fixed box away from the viewport pixels the pointer and the boxes are measured in. */}
      {createPortal(
        <>
          {moves.ghost && <div className="pj-ghost" ref={moves.ghostRef}><b>⠿</b>{moves.ghost.name}<i>{moves.ghost.pos}</i></div>}
          {moves.mark && (
            <div
              className={`pj-mark ${moves.mark.orient}`}
              style={{ left: moves.mark.left, top: moves.mark.top, width: moves.mark.width, height: moves.mark.height }}
            />
          )}
        </>,
        document.body
      )}
    </div>
  );
}

/** The refusal line under a project's dir; a dead pin's sentence is its chip's tooltip, so a tile's height never depends on it. */
function Notes({ it }: { it: Item }) {
  return <>{it.error && <span className="pin-sub err">{it.error}</span>}</>;
}

/** A dead pin's chip, drawn where a live one shows its age. The tooltip opens on hover and on focus, so a keyboard reaches the sentence too. */
function GoneChip({ dirName }: { dirName: string }) {
  const tipId = `pj-tip-${dirName}`;
  return (
    <button type="button" className="pj-gone" aria-describedby={tipId}>
      <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
        <path d="M6 1.5 11 10.5H1z" />
        <path d="M6 5v2.2M6 8.6v.1" />
      </svg>
      {PROJECTS_GONE_CHIP}
      <span className="pj-tip" role="tooltip" id={tipId}>{PROJECTS_MISSING}</span>
    </button>
  );
}

function PinButton({ it }: { it: Item }) {
  return <button type="button" className="qp-term" disabled={it.disabled} onClick={it.onClick}>{it.label}</button>;
}

/** The class suffix for a pin's lead column and the dimmed drag source. */
const leadCls = (it: Item): string => `${it.grip === undefined ? '' : ' g'}${it.src ? ' src' : ''}`;

/** A group head — with `Saved` after it on Pinned — and its tiles — a pin a paper tile, an offer its dashed outline — or the group's empty note. */
function TileGroup({ title, total, items, empty, aside }: { title: string; total: number; items: Item[]; empty: ReactNode; aside?: ReactNode }) {
  return (
    <>
      <div className="pin-group">{title}<span className="pin-count">{total}</span>{aside}</div>
      {items.length > 0 ? (
        <ul className="pj-tiles">
          {items.map(it => (
            <li key={it.dirName} className={`pj-tile${it.on ? '' : ' off'}${it.gone ? ' gone' : ''}${leadCls(it)}`} ref={it.ref}>
              {it.grip}
              <span className="pj-id">
                <span className="pj-name">{it.name}</span>
                {it.dir && <span className="pj-dir">{it.dir}</span>}
                <Notes it={it} />
              </span>
              <span className="pj-tfoot">
                {it.gone ? <GoneChip dirName={it.dirName} /> : (
                  <span className="pj-age">{it.lastActiveMs === null ? 'No sessions' : `Last session ${formatAgo(it.lastActiveMs)} ago`}</span>
                )}
                <PinButton it={it} />
              </span>
            </li>
          ))}
        </ul>
      ) : empty}
    </>
  );
}

/** Lists: one group as a Settings card, each project a setting row — name over its dir, the age and the key on the right. */
function ListCard({ title, total, items, sub, empty, aside }: {
  title: string; total: number; items: Item[]; sub: string; empty: ReactNode; aside?: ReactNode;
}) {
  return (
    <SettingsGroup className="pj-listcard" title={title} sub={`${items.length} of ${total} · ${sub}`} aside={aside}>
      {items.length > 0 ? items.map(it => {
        const hint = it.dir || it.error ? <>{it.dir}<Notes it={it} /></> : undefined;
        return (
          <SettingsRow
            key={it.dirName}
            className={`pj-srw${it.gone ? ' gone' : ''}${leadCls(it)}`}
            name={it.name}
            hint={hint}
            lead={it.grip}
            rowRef={it.ref}
          >
            {it.gone ? <GoneChip dirName={it.dirName} /> : (
              <span className="pj-age">{it.lastActiveMs === null ? 'No sessions' : `${formatAgo(it.lastActiveMs)} ago`}</span>
            )}
            <PinButton it={it} />
          </SettingsRow>
        );
      }) : empty}
    </SettingsGroup>
  );
}
