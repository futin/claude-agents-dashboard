import type { EmptyState as Empty, FilterKey } from '../../lib/filterSort';

const FILTER_LABEL: Record<FilterKey, string> = {
  projects: 'project',
  statuses: 'status',
  window: 'activity window'
};

/** "project", "project and status", "project, status and activity window". */
function joinLabels(keys: FilterKey[]): string {
  const labels = keys.map(k => FILTER_LABEL[k]);
  if (labels.length < 2) return labels.join('');
  return labels.slice(0, -1).join(', ') + ' and ' + labels[labels.length - 1];
}

/**
 * What every view shows in place of its body while there is nothing to draw.
 * Two empty branches, not one: filters that emptied the list are named and
 * given an exit; anything else is the server's lookback, which is the only
 * case the original wording was ever true for (see view-persistence.md).
 */
export function EmptyState({ loading, empty, onClearFilters }: {
  loading: boolean;
  empty: Empty | null;
  onClearFilters: () => void;
}) {
  if (loading) {
    return <div className="s-card empty"><div className="e">◌</div>Loading…</div>;
  }
  const hidden = empty && !empty.payloadEmpty && empty.culprits.length > 0;
  return (
    <div className="s-card empty">
      <div className="e">◌</div>
      {hidden ? (
        <>
          {empty.total === 1
            ? `The only session is hidden by the ${joinLabels(empty.culprits)} filter`
            : `All ${empty.total} sessions are hidden by the ${joinLabels(empty.culprits)} filter`}
          {empty.culprits.length > 1 ? 's.' : '.'}
          <div><button type="button" className="clear-filters" onClick={onClearFilters}>Clear filters</button></div>
        </>
      ) : 'No recent sessions in the lookback window.'}
    </div>
  );
}
