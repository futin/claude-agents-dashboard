import { useMemo, type ReactNode } from 'react';

import { usePersistedState } from '../../hooks/usePersistedState';
import type { Entry, EntryGroup } from '../../lib/managementEntries';

interface Props {
  groups: EntryGroup[];
  allGroups: EntryGroup[];
  filter: string;
  onFilter: (q: string) => void;
  selectedKey: string | null;
  onSelect: (e: Entry) => void;
}

/** Plugin sub-groups start collapsed; user/project and hook events start open. */
function collapsedByDefault(groupTitle: string, subgroup: string): boolean {
  return groupTitle !== 'Hooks' && subgroup !== 'user' && subgroup !== 'project';
}

/** 'plugin:x' → 'x' for display; the sub-group header already carries context. */
function badgeText(badge: string): string {
  return badge.startsWith('plugin:') ? badge.slice('plugin:'.length) : badge;
}

/**
 * Middle pane: filter box + entries grouped by type. Empty groups are hidden.
 * Both the type header and each sub-group header collapse their contents;
 * entries arrive pre-sorted so equal subgroups are contiguous. Collapse state
 * survives refresh (localStorage) and is ignored while filtering (matches must
 * always be visible). Keys are type-title based, so a collapsed group stays
 * collapsed across scopes.
 */
export function ItemList({ groups, allGroups, filter, onFilter, selectedKey, onSelect }: Props) {
  const filtered = filter.trim() !== '';
  // Filtered view already drops empty groups; hide them from the full view too.
  const shown = (filtered ? groups : allGroups).filter(g => g.entries.length > 0);
  // Keys of groups/sub-groups the user toggled away from their default state.
  const [collapsedKeys, setCollapsedKeys] = usePersistedState<string[]>('management.collapsed', []);
  const toggled = useMemo(() => new Set(collapsedKeys), [collapsedKeys]);

  const toggle = (key: string) => {
    const next = new Set(toggled);
    if (next.has(key)) next.delete(key); else next.add(key);
    setCollapsedKeys([...next]);
  };

  const renderGroup = (g: EntryGroup): ReactNode[] => {
    const rows: ReactNode[] = [];
    let prevSub: string | null = null;
    let collapsed = false;
    for (const e of g.entries) {
      if (e.subgroup === null) collapsed = false;
      else if (e.subgroup !== prevSub) {
        const subKey = `${g.title}/${e.subgroup}`;
        const count = g.entries.filter(x => x.subgroup === e.subgroup).length;
        collapsed = !filtered && (collapsedByDefault(g.title, e.subgroup) !== toggled.has(subKey));
        rows.push(
          <div className="msub-h" key={`sub:${subKey}`} onClick={() => toggle(subKey)}>
            <span className={collapsed ? 'msub-caret' : 'msub-caret open'}>▸</span>
            {e.subgroup} · {count}
          </div>
        );
      }
      prevSub = e.subgroup;
      if (collapsed) continue;
      rows.push(
        <div
          key={e.key}
          className={e.key === selectedKey ? 'mitem on' : 'mitem'}
          onClick={() => onSelect(e)}
        >
          <div className="mitem-top">
            <span className="mitem-name">{e.label}</span>
            <span className={e.badge.startsWith('plugin:') ? 'msrc plugin' : 'msrc'}>{badgeText(e.badge)}</span>
          </div>
          {e.sublabel !== null ? <div className="mitem-desc">{e.sublabel}</div> : null}
        </div>
      );
    }
    return rows;
  };

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
        shown.map(g => {
          const groupKey = `#${g.title}`;
          const collapsed = !filtered && toggled.has(groupKey);
          return (
            <div className="mgroup" key={g.title}>
              <div className="mgroup-h" onClick={() => toggle(groupKey)}>
                <span className={collapsed ? 'msub-caret' : 'msub-caret open'}>▸</span>
                {g.title} · {g.entries.length}
              </div>
              {collapsed ? null : renderGroup(g)}
            </div>
          );
        })
      )}
    </div>
  );
}
