/**
 * managementEntries.ts — normalize a ScopeConfig into the flat, selectable
 * entry groups the middle pane renders. Pure (unit-tested server-side).
 */

import type { ConfigItem, ScopeConfig } from '../../../shared/types';

/** One selectable row in the item list. */
export interface Entry {
  /** Unique within the scope — selection key. */
  key: string;
  label: string;
  sublabel: string | null;
  /** Source badge: 'user' | 'project' | 'plugin:<name>' | 'v1.0' | 'disabled'. */
  badge: string;
  /** File shown in the detail pane; null → metadata only. */
  filePath: string | null;
}

export interface EntryGroup {
  title: string;
  entries: Entry[];
}

function fromItems(items: ConfigItem[]): Entry[] {
  return items.map(i => ({
    key: i.path,
    label: i.name,
    sublabel: i.description,
    badge: i.source,
    filePath: i.path
  }));
}

/** Group order is fixed; Plugins appears for the global scope only. */
export function buildEntries(scope: ScopeConfig): EntryGroup[] {
  const groups: EntryGroup[] = [];

  if (scope.scope === 'global') {
    groups.push({
      title: 'Plugins',
      entries: scope.plugins.map(p => ({
        key: `plugin:${p.key}`,
        label: p.name,
        sublabel: p.description,
        badge: p.enabled ? (p.version ? `v${p.version}` : 'enabled') : 'disabled',
        filePath: p.manifestPath
      }))
    });
  }

  groups.push(
    { title: 'Skills', entries: fromItems(scope.skills) },
    { title: 'Agents', entries: fromItems(scope.agents) },
    { title: 'Commands', entries: fromItems(scope.commands) },
    { title: 'Rules', entries: fromItems(scope.rules) },
    {
      title: 'Hooks',
      entries: scope.hooks.map((h, i) => ({
        key: `hook:${i}:${h.declaredIn}:${h.event}`,
        label: h.matcher ? `${h.event} · ${h.matcher}` : h.event,
        sublabel: h.command,
        badge: h.source,
        filePath: h.scriptPath ?? h.declaredIn
      }))
    },
    { title: 'Memory', entries: fromItems(scope.memory) },
    {
      title: 'Settings',
      entries: scope.settings.filter(s => s.exists).map(s => ({
        key: s.path,
        label: s.label,
        sublabel: null,
        badge: scope.scope === 'global' ? 'user' : 'project',
        filePath: s.path
      }))
    }
  );

  return groups;
}

/** Case-insensitive label+sublabel match; empty query returns groups as-is. */
export function filterEntries(groups: EntryGroup[], query: string): EntryGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  const out: EntryGroup[] = [];
  for (const g of groups) {
    const entries = g.entries.filter(
      e => e.label.toLowerCase().includes(q) || (e.sublabel !== null && e.sublabel.toLowerCase().includes(q))
    );
    if (entries.length > 0) out.push({ title: g.title, entries });
  }
  return out;
}
