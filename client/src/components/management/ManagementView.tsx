import { useMemo, useState } from 'react';

import { DetailPane } from './DetailPane';
import { ItemList } from './ItemList';
import { ScopeMenu } from './ScopeMenu';
import { useManagementIndex, useProjectScope } from '../../hooks/useManagement';
import { usePersistedState } from '../../hooks/usePersistedState';
import { buildEntries, filterEntries } from '../../lib/managementEntries';

/**
 * Management section — read-only three-pane view over Claude config: scope
 * menu (Global + recent projects) | filterable item list grouped by type |
 * detail pane with the selected item's file content. Default export: loaded
 * via React.lazy so the sessions bundle stays unchanged.
 */
export default function ManagementView() {
  const [scopeSel, setScopeSel] = usePersistedState<string>('management.scope', 'global');
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const { index, loading, error } = useManagementIndex(refreshKey);

  // Stale persisted scope (project aged out of the recent list) → fall back
  // to 'global', derived during render — no effect needed.
  const scope = scopeSel === 'global' || (index !== null && index.projects.some(p => p.dirName === scopeSel))
    ? scopeSel
    : 'global';

  const projectScope = useProjectScope(scope === 'global' ? null : scope, refreshKey);
  const config = scope === 'global' ? (index !== null ? index.global : null) : projectScope;

  const allGroups = useMemo(() => (config !== null ? buildEntries(config) : []), [config]);
  const groups = useMemo(() => filterEntries(allGroups, filter), [allGroups, filter]);

  // Selection is derived: a key that no longer exists in this scope (scope
  // switch, refresh) simply resolves to null.
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

  return (
    <>
      <div className="mgmt-bar">
        <span className="mgmt-title">Claude configuration</span>
        {error ? <span className="off">scan failed — showing last snapshot</span> : null}
        <button className="tb-dir" onClick={() => setRefreshKey(k => k + 1)}>↻ refresh</button>
      </div>
      <div className="mgmt">
        <ScopeMenu projects={index.projects} selected={scope} onSelect={setScopeSel} />
        {config === null ? (
          <div className="mgmt-empty">loading scope…</div>
        ) : (
          <ItemList
            groups={groups}
            allGroups={allGroups}
            filter={filter}
            onFilter={setFilter}
            selectedKey={selected !== null ? selected.entry.key : null}
            onSelect={e => setSelectedKey(e.key)}
          />
        )}
        <DetailPane
          entry={selected !== null ? selected.entry : null}
          groupTitle={selected !== null ? selected.groupTitle : null}
        />
      </div>
    </>
  );
}
