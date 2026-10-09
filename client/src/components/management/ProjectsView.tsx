import { useState } from 'react';
import type { ReactNode } from 'react';

import { usePins } from '../../hooks/usePins';
import { usePersistedState } from '../../hooks/usePersistedState';
import { formatAgo } from '../../lib/format';
import {
  DEFAULT_PROJECTS_LAYOUT, LIST_SUB_OFFERS, LIST_SUB_PINNED, PROJECTS_BAND_SUB, PROJECTS_LAYOUTS, PROJECTS_MISSING,
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
}

/**
 * Management › Projects: the band, a toolbar of the Tiles | Columns | Lists switcher and one filter box, then the stored pins and the projects on offer
 * in the shape the switcher picks. The pin ledger used to be a PinPicker in a Settings card; it is now the page's own content, on the app ground.
 *
 * Grouping, the filter match, the dir line and every string come from `lib/projectsView.ts`. A click never moves a project by hand: `usePins` answers with
 * the fresh payload and the groups re-split from it. A refusal shows inline under that project and changes nothing. Enter in the filter pins the first
 * offered match and clears the box, as in the launch sheet's picker.
 */
export default function ProjectsView() {
  const { pins, busy, setPin } = usePins();
  const [stored, setStored] = usePersistedState<string>('management.projectsLayout', DEFAULT_PROJECTS_LAYOUT);
  const layout: ProjectsLayout = isProjectsLayout(stored) ? stored : DEFAULT_PROJECTS_LAYOUT;
  const [query, setQuery] = useState('');
  const [error, setError] = useState<{ dirName: string; text: string } | null>(null);

  async function act(dirName: string, pinned: boolean, clearQuery: boolean): Promise<void> {
    if (busy) return;
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
    error: error?.dirName === r.dirName ? error.text : null,
    label: busy === r.dirName ? (on ? 'Unpinning…' : 'Pinning…') : (on ? 'Unpin' : 'Pin'),
    disabled: busy !== null,
    onClick: () => void act(r.dirName, !on, !on),
  });
  const pinItems = pinnedShown.map(r => item(r, true));
  const offerItems = offersShown.map(r => item(r, false));
  const noPins = <div className="pin-note">{noPinsText(pinned.length)}</div>;
  const noOffers = <div className="pin-note">{noOffersText(offers.length)}</div>;
  const pinGroup = <TileGroup title="Pinned" total={pinned.length} items={pinItems} empty={noPins} />;
  const offerGroup = <TileGroup title="Not pinned" total={offers.length} items={offerItems} empty={noOffers} />;

  let body: ReactNode;
  if (layout === 'lists') {
    body = (
      <div className="pj-cols">
        <ListCard title="Not pinned" total={offers.length} items={offerItems} sub={LIST_SUB_OFFERS} empty={noOffers} />
        <ListCard title="Pinned" total={pinned.length} items={pinItems} sub={LIST_SUB_PINNED} empty={noPins} />
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
    </div>
  );
}

/** The dead-pin and refusal lines under a project's dir. */
function Notes({ it }: { it: Item }) {
  return (
    <>
      {it.gone && <span className="pin-sub">{PROJECTS_MISSING}</span>}
      {it.error && <span className="pin-sub err">{it.error}</span>}
    </>
  );
}

function PinButton({ it }: { it: Item }) {
  return <button type="button" className="qp-term" disabled={it.disabled} onClick={it.onClick}>{it.label}</button>;
}

/** A group head and its tiles — a pin a paper tile, an offer its dashed outline — or the group's empty note. */
function TileGroup({ title, total, items, empty }: { title: string; total: number; items: Item[]; empty: ReactNode }) {
  return (
    <>
      <div className="pin-group">{title}<span className="pin-count">{total}</span></div>
      {items.length > 0 ? (
        <ul className="pj-tiles">
          {items.map(it => (
            <li key={it.dirName} className={`pj-tile${it.on ? '' : ' off'}${it.gone ? ' gone' : ''}`}>
              <span className="pj-id">
                <span className="pj-name">{it.name}</span>
                {it.dir && <span className="pj-dir">{it.dir}</span>}
                <Notes it={it} />
              </span>
              <span className="pj-tfoot">
                <span className="pj-age">{it.lastActiveMs === null ? 'No sessions' : `Last session ${formatAgo(it.lastActiveMs)} ago`}</span>
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
function ListCard({ title, total, items, sub, empty }: { title: string; total: number; items: Item[]; sub: string; empty: ReactNode }) {
  return (
    <SettingsGroup className="pj-listcard" title={title} sub={`${items.length} of ${total} · ${sub}`}>
      {items.length > 0 ? items.map(it => {
        const hint = it.dir || it.gone || it.error ? <>{it.dir}<Notes it={it} /></> : undefined;
        return (
          <SettingsRow key={it.dirName} className={it.gone ? 'pj-srw gone' : 'pj-srw'} name={it.name} hint={hint}>
            <span className="pj-age">{it.lastActiveMs === null ? 'No sessions' : `${formatAgo(it.lastActiveMs)} ago`}</span>
            <PinButton it={it} />
          </SettingsRow>
        );
      }) : empty}
    </SettingsGroup>
  );
}
