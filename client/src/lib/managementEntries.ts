/**
 * managementEntries.ts — normalize a ScopeConfig into the flat, selectable
 * entry groups the middle pane renders. Pure (unit-tested server-side).
 */

import type { ConfigItem, HookInfo, ScopeConfig } from '../../../shared/types';

export type FileKind = 'markdown' | 'json' | 'text';

/** One file of a skill directory, ready to open in the detail pane. */
export interface EntryFile {
  /** Path relative to the skill dir — the rail's label. */
  rel: string;
  /** Absolute path, resolved off SKILL.md's dir; what the file endpoint takes. */
  path: string;
  size: number;
  fileKind: FileKind;
}

interface EntryBase {
  /** Unique within the scope — selection key. */
  key: string;
  label: string;
  sublabel: string | null;
  /** Source badge: 'user' | 'project' | 'plugin:<name>' | 'v1.0' | 'disabled'. */
  badge: string;
  /** File shown in the detail pane; null → metadata only. */
  filePath: string | null;
  /** Sub-group header within the group (plugin name, hook event); null → ungrouped. */
  subgroup: string | null;
}

/** One selectable row in the item list. */
export type Entry =
  | (EntryBase & { kind: 'file'; fileKind: FileKind; files?: EntryFile[] })
  | (EntryBase & { kind: 'hook'; hook: HookInfo });

export interface EntryGroup {
  title: string;
  entries: Entry[];
}

function fileKind(path: string | null): FileKind {
  if (path === null) return 'text';
  if (path.endsWith('.md')) return 'markdown';
  if (path.endsWith('.json')) return 'json';
  return 'text';
}

/** 'plugin:<name>' → subgroup '<name>'; local sources keep their own name. */
function itemSubgroup(source: string): string {
  return source.startsWith('plugin:') ? source.slice('plugin:'.length) : source;
}

/** user/project first, then plugin subgroups alphabetically; labels alphabetical within. */
function bySubgroupThenLabel(a: Entry, b: Entry): number {
  const aLocal = a.subgroup === 'user' || a.subgroup === 'project';
  const bLocal = b.subgroup === 'user' || b.subgroup === 'project';
  if (aLocal !== bLocal) return aLocal ? -1 : 1;
  const as = a.subgroup ?? '';
  const bs = b.subgroup ?? '';
  if (as !== bs) return as < bs ? -1 : 1;
  if (a.label !== b.label) return a.label < b.label ? -1 : 1;
  return 0;
}

/** Drop the last '/'-segment of an absolute path — the skill dir of a SKILL.md. */
function dirOf(p: string): string {
  const cut = p.lastIndexOf('/');
  return cut <= 0 ? p : p.slice(0, cut);
}

/** ConfigItem.files (rel + size) → openable entry files, rooted at the item's dir. */
function toEntryFiles(item: ConfigItem): EntryFile[] | undefined {
  if (item.files === undefined || item.files.length === 0) return undefined;
  const dir = dirOf(item.path);
  return item.files.map(f => ({
    rel: f.rel,
    path: `${dir}/${f.rel}`,
    size: f.size,
    fileKind: fileKind(f.rel)
  }));
}

function fromItems(items: ConfigItem[], subgrouped: boolean): Entry[] {
  const entries: Entry[] = items.map(i => ({
    kind: 'file',
    fileKind: fileKind(i.path),
    key: i.path,
    label: i.name,
    sublabel: i.description,
    badge: i.source,
    filePath: i.path,
    subgroup: subgrouped ? itemSubgroup(i.source) : null,
    ...(toEntryFiles(i) !== undefined ? { files: toEntryFiles(i) } : {})
  }));
  if (subgrouped) entries.sort(bySubgroupThenLabel);
  return entries;
}

function fromHooks(hooks: HookInfo[]): Entry[] {
  const sorted = [...hooks].sort((a, b) => (a.event < b.event ? -1 : a.event > b.event ? 1 : 0));
  return sorted.map((h, i) => ({
    kind: 'hook',
    hook: h,
    key: `hook:${i}:${h.declaredIn}:${h.event}`,
    label: h.matcher ? `${h.event} · ${h.matcher}` : h.event,
    sublabel: h.command,
    badge: h.source,
    filePath: h.scriptPath ?? h.declaredIn,
    subgroup: h.event
  }));
}

/** Group order is fixed; Plugins appears for the global scope only. */
export function buildEntries(scope: ScopeConfig): EntryGroup[] {
  const groups: EntryGroup[] = [];

  if (scope.scope === 'global') {
    groups.push({
      title: 'Plugins',
      entries: scope.plugins.map(p => ({
        kind: 'file',
        fileKind: fileKind(p.manifestPath),
        key: `plugin:${p.key}`,
        label: p.name,
        sublabel: p.description,
        badge: p.enabled ? (p.version ? `v${p.version}` : 'enabled') : 'disabled',
        filePath: p.manifestPath,
        subgroup: null
      }))
    });
  }

  groups.push(
    { title: 'Skills', entries: fromItems(scope.skills, true) },
    { title: 'Agents', entries: fromItems(scope.agents, true) },
    { title: 'Commands', entries: fromItems(scope.commands, true) },
    { title: 'Rules', entries: fromItems(scope.rules, false) },
    { title: 'Hooks', entries: fromHooks(scope.hooks) },
    { title: 'Memory', entries: fromItems(scope.memory, false) },
    {
      title: 'Settings',
      entries: scope.settings.filter(s => s.exists).map(s => ({
        kind: 'file' as const,
        fileKind: 'json' as const,
        key: s.path,
        label: s.label,
        sublabel: null,
        badge: scope.scope === 'global' ? 'user' : 'project',
        filePath: s.path,
        subgroup: null
      }))
    }
  );

  return groups;
}

/** One line of the skill file rail: a folder header, or an openable file. */
export type RailRow =
  | { kind: 'dir'; dir: string }
  | { kind: 'file'; label: string; file: EntryFile; nested: boolean };

/**
 * Flatten a skill's files into rail lines: root-level files first (SKILL.md
 * leads, since readSkillFiles sorts it there), then one header per folder with
 * its files under it. Folders keep their full relative path as the header, so a
 * nested `scripts/deep/` reads correctly without an indent ladder.
 */
export function railRows(files: EntryFile[]): RailRow[] {
  const roots: RailRow[] = [];
  const dirs = new Map<string, RailRow[]>();

  for (const file of files) {
    const cut = file.rel.lastIndexOf('/');
    if (cut === -1) {
      roots.push({ kind: 'file', label: file.rel, file, nested: false });
      continue;
    }
    const dir = file.rel.slice(0, cut);
    const rows = dirs.get(dir) ?? [];
    rows.push({ kind: 'file', label: file.rel.slice(cut + 1), file, nested: true });
    dirs.set(dir, rows);
  }

  const out = [...roots];
  for (const dir of [...dirs.keys()].sort()) {
    out.push({ kind: 'dir', dir: `${dir}/` });
    out.push(...dirs.get(dir)!);
  }
  return out;
}

/**
 * Case-insensitive label+sublabel match, plus a skill's own file names — so
 * searching a reference doc finds the skill that ships it. Empty query returns
 * groups as-is.
 */
export function filterEntries(groups: EntryGroup[], query: string): EntryGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  const matches = (e: Entry): boolean =>
    e.label.toLowerCase().includes(q) ||
    (e.sublabel !== null && e.sublabel.toLowerCase().includes(q)) ||
    (e.kind === 'file' && (e.files ?? []).some(f => f.rel.toLowerCase().includes(q)));
  const out: EntryGroup[] = [];
  for (const g of groups) {
    const entries = g.entries.filter(matches);
    if (entries.length > 0) out.push({ title: g.title, entries });
  }
  return out;
}
