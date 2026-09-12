import { useMemo, useState } from 'react';

import { DetailPane } from './DetailPane';
import { ItemList } from './ItemList';
import { TypeColumn } from './TypeColumn';
import { useProjectScope } from '../../hooks/useManagement';
import { scopeLabel, useManagementScope } from '../../hooks/useManagementScope';
import { usePersistedState } from '../../hooks/usePersistedState';
import { buildEntries, filterEntries } from '../../lib/managementEntries';

/**
 * Management section — read-only browser over Claude config, drawn as the three
 * columns of DESIGN.md §8.5: type | item | file.
 *
 * The scope is *not* here: it is the rail's sub-nav (`SideRail`), and this view
 * reads it — plus the one `/api/management` fetch that feeds both — out of
 * `ManagementScopeProvider`. The band names the scope and spells out its path,
 * since the rail only carries the label.
 *
 * Everything that can go stale resolves during render rather than in an effect:
 * a persisted scope whose project aged out (in the provider), a selection whose
 * key is not in this scope, and a picked type the filter emptied. Default
 * export: loaded via React.lazy so the sessions bundle stays unchanged.
 */
export default function ManagementView() {
  const { index, loading, error, projects, scope, refreshKey, refresh } = useManagementScope();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  // Which type the columns are showing — persisted like the section's other
  // state, resolved below so a filter that empties it cannot strand the page.
  const [typeSel, setTypeSel] = usePersistedState<string>('management.type', 'Skills');

  const projectScope = useProjectScope(scope === 'global' ? null : scope, refreshKey);
  const config = scope === 'global' ? (index !== null ? index.global : null) : projectScope;

  const allGroups = useMemo(() => (config !== null ? buildEntries(config) : []), [config]);
  // One list drives both list columns: the type column's counts are the
  // filter's counts, and the item card draws whichever of these is picked.
  // `filterEntries` returns the groups unchanged for an empty query, so the
  // only extra job here is dropping types with nothing in them.
  const groups = useMemo(
    () => filterEntries(allGroups, filter).filter(g => g.entries.length > 0),
    [allGroups, filter]
  );

  // A filter that empties the picked type falls back to the first type still
  // standing rather than showing an empty card; nothing at all → null, and the
  // item card says so.
  const type = groups.some(g => g.title === typeSel) ? typeSel : (groups[0]?.title ?? null);
  const group = groups.find(g => g.title === type) ?? null;
  // Unfiltered population of the picked type, for the card's "n of m" subtitle.
  const total = allGroups.find(g => g.title === type)?.entries.length ?? 0;

  // Selection is derived: a key that no longer exists in this scope (scope
  // switch, refresh) resolves to null — and with the file column drawn only
  // when something is selected, the column then simply disappears.
  const selected = useMemo(() => {
    if (selectedKey === null) return null;
    for (const g of allGroups) {
      const hit = g.entries.find(e => e.key === selectedKey);
      if (hit !== undefined) return { entry: hit, groupTitle: g.title };
    }
    return null;
  }, [allGroups, selectedKey]);

  if (loading && index === null) return <div className="mgmt-empty">loading config…</div>;
  if (index === null) return <div className="mgmt-empty off">couldn't load management data</div>;

  const here = scopeLabel(scope, projects);

  return (
    <>
      {/* The band is two rows, not one row with a two-line left half: the title
          and ↻ centre on each other, and the line runs the full width under
          them. The pill stays neutral — the green `.set-scope` fill means
          "every device" on Settings and would lie about a config scope. */}
      <div className="mgmt-bar">
        <div className="mgmt-bandrow">
          <span className="mgmt-title">
            Management · {here.name}
            <span className="set-scope"><i aria-hidden="true" />{here.path}</span>
          </span>
          {error ? <span className="off">scan failed — showing last snapshot</span> : null}
          <button className="tb-dir" onClick={refresh}>↻ refresh</button>
        </div>
        <div className="mgmt-sub">
          Every skill, agent, command, rule, hook, memory file, settings file and installed plugin
          in this scope. Read-only — nothing here is ever written, and config changes over days, so
          this section does not poll.
        </div>
      </div>
      <div className={selected !== null ? 'mgmt' : 'mgmt pair'}>
        <TypeColumn groups={groups} selected={type} onSelect={setTypeSel} />
        {config === null ? (
          <div className="mgmt-list"><div className="mgmt-empty">loading scope…</div></div>
        ) : (
          <ItemList
            group={group}
            type={type}
            total={total}
            filter={filter}
            onFilter={setFilter}
            selectedKey={selected !== null ? selected.entry.key : null}
            /* clicking the open item closes it — the only way back to two
               columns once the third has arrived */
            onSelect={e => setSelectedKey(k => (k === e.key ? null : e.key))}
          />
        )}
        {selected !== null && <DetailPane entry={selected.entry} groupTitle={selected.groupTitle} />}
      </div>
    </>
  );
}
