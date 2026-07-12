import type { Entry, EntryGroup } from '../../lib/managementEntries';

interface Props {
  groups: EntryGroup[];
  allGroups: EntryGroup[];
  filter: string;
  onFilter: (q: string) => void;
  selectedKey: string | null;
  onSelect: (e: Entry) => void;
}

/**
 * Middle pane: filter box + entries grouped by type. `groups` is the
 * filtered view; `allGroups` decides which headings exist at all (an empty
 * group shows "none" — absence is information in a management view).
 */
export function ItemList({ groups, allGroups, filter, onFilter, selectedKey, onSelect }: Props) {
  const filtered = filter.trim() !== '';
  const shown = filtered ? groups : allGroups;

  return (
    <div className="mgmt-list">
      <input
        className="mgmt-filter"
        type="text"
        placeholder="filter…"
        value={filter}
        onChange={e => onFilter(e.target.value)}
      />
      {shown.length === 0 ? (
        <div className="mgmt-empty">no matches</div>
      ) : (
        shown.map(g => (
          <div className="mgroup" key={g.title}>
            <div className="mgroup-h">{g.title} · {g.entries.length}</div>
            {g.entries.length === 0 ? (
              <div className="mgmt-empty">none</div>
            ) : (
              g.entries.map(e => (
                <div
                  key={e.key}
                  className={e.key === selectedKey ? 'mitem on' : 'mitem'}
                  onClick={() => onSelect(e)}
                >
                  <div className="mitem-top">
                    <span className="mitem-name">{e.label}</span>
                    <span className={e.badge.startsWith('plugin:') ? 'msrc plugin' : 'msrc'}>{e.badge}</span>
                  </div>
                  {e.sublabel !== null ? <div className="mitem-desc">{e.sublabel}</div> : null}
                </div>
              ))
            )}
          </div>
        ))
      )}
    </div>
  );
}
