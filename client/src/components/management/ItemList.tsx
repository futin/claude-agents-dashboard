import { useMemo, type ReactNode } from 'react';

import { usePersistedState } from '../../hooks/usePersistedState';
import type { Entry, EntryGroup } from '../../lib/managementEntries';

interface Props {
  /** The picked type's entries, already filtered; null when nothing matches. */
  group: EntryGroup | null;
  /** The picked type's title — the card's category heading. */
  type: string | null;
  /** How many of this type the scope holds before the filter. */
  total: number;
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
 * Column 2 — one type's items as a Settings card (DESIGN.md §8.2/§8.5): the
 * type is the category title, the subtitle counts what the filter left and says
 * what the filter matches, then the filter box, then one `.set-row`-shaped row
 * per item — name with its source badge beside it, description beneath the
 * pair, a hairline between rows. Same furniture as a preferences card, so
 * "a skill" and "a setting" read as the same kind of thing.
 *
 * The source sub-groups survive as collapsible labelled rows between the items:
 * flattening them away would lose the one split that tells a user's skill from
 * a plugin's. Collapse state survives refresh (localStorage, keyed by type so
 * it holds across scopes) and is ignored while filtering — a match must always
 * be visible. The *type* group no longer collapses: it is a column now.
 */
export function ItemList({ group, type, total, filter, onFilter, selectedKey, onSelect }: Props) {
  const filtered = filter.trim() !== '';
  // Keys of sub-groups the user toggled away from their default state.
  const [collapsedKeys, setCollapsedKeys] = usePersistedState<string[]>('management.collapsed', []);
  const toggled = useMemo(() => new Set(collapsedKeys), [collapsedKeys]);

  const toggle = (key: string) => {
    const next = new Set(toggled);
    if (next.has(key)) next.delete(key); else next.add(key);
    setCollapsedKeys([...next]);
  };

  const rows = (g: EntryGroup): ReactNode[] => {
    const out: ReactNode[] = [];
    let prevSub: string | null = null;
    let collapsed = false;
    for (const e of g.entries) {
      if (e.subgroup === null) collapsed = false;
      else if (e.subgroup !== prevSub) {
        const subKey = `${g.title}/${e.subgroup}`;
        const count = g.entries.filter(x => x.subgroup === e.subgroup).length;
        collapsed = !filtered && (collapsedByDefault(g.title, e.subgroup) !== toggled.has(subKey));
        out.push(
          <button className="msub-h" key={`sub:${subKey}`} onClick={() => toggle(subKey)}>
            <span className={collapsed ? 'msub-caret' : 'msub-caret open'}>▸</span>
            {e.subgroup}
            <span className="msub-c">· {count}</span>
          </button>
        );
      }
      prevSub = e.subgroup;
      if (collapsed) continue;
      out.push(
        <button
          key={e.key}
          className={e.key === selectedKey ? 'mitem on' : 'mitem'}
          aria-current={e.key === selectedKey ? 'true' : undefined}
          onClick={() => onSelect(e)}
        >
          {/* spans, not divs — a button's content model is phrasing — so the
              two lines are made blocks in CSS rather than by the tag */}
          <span className="mitem-label">
            <span className="mitem-top">
              <span className="mitem-name">{e.label}</span>
              <span className={e.badge.startsWith('plugin:') ? 'msrc plugin' : 'msrc'}>{badgeText(e.badge)}</span>
            </span>
            {e.sublabel !== null ? <span className="mitem-desc">{e.sublabel}</span> : null}
          </span>
        </button>
      );
    }
    return out;
  };

  return (
    <section className="mgmt-list">
      <div className="mgmt-ct">{type ?? 'Nothing here'}</div>
      <div className="mgmt-cs">
        {group !== null
          ? `${group.entries.length} of ${total} in this scope · the filter matches names, descriptions and, for a skill, its file names`
          : 'No item of this type matches the filter'}
      </div>
      <input
        className="mgmt-filter"
        type="text"
        placeholder="filter…"
        value={filter}
        onChange={e => onFilter(e.target.value)}
      />
      {group === null ? (
        <div className="mgmt-empty">no matches</div>
      ) : (
        <div className="mgmt-rows">{rows(group)}</div>
      )}
    </section>
  );
}
