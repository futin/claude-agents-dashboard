import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import { useConfigsIndex, type IndexState } from './useConfigs';
import { usePersistedState } from './usePersistedState';
import type { ProjectRef } from '../../../shared/types';

/**
 * The Claude Configs scope, shared between the rail and the page.
 *
 * DESIGN.md §8.5 moves the scope out of the page and into the sidebar as
 * Claude Configs' sub-nav, which puts the recent-project list — part of
 * `GET /api/configs` — on the far side of the `React.lazy` boundary that
 * owns that fetch. Three shapes were possible: portal the rail's rows out of
 * the lazy chunk, drill six props through `AppShell`, or hoist the scope state
 * and the one index fetch into a context above both. This is the third.
 *
 * What it buys, against the constraints:
 * - **One fetch.** `useConfigsIndex` is called here and nowhere else;
 *   `ConfigsView` reads the same object out of the context.
 * - **The sessions bundle keeps its size.** Only `useConfigs.ts` (three
 *   fetch hooks, no components) moves into the main chunk — the configs
 *   *chunk* is still lazy, and nothing imports it until the section opens.
 * - **One scan per load.** `active` still gates the effect, but `App` passes it
 *   unconditionally: the phone menu draws every tree from the first paint,
 *   Claude Configs' list of projects among them, so the index has to be there
 *   before the section is opened. Re-entering the section no longer re-scans —
 *   ↻ in the band is the control that does, and config changes over days.
 */
export interface ConfigsScopeState extends IndexState {
  /** Recently-active projects for the rail's tree; empty until the index lands. */
  projects: ProjectRef[];
  /**
   * Resolved scope id: `'global'`, or a `dirName` that still exists in the
   * index. A persisted project that aged out of the recent list resolves back
   * to `'global'` during render — no effect, same as the old page-local state.
   */
  scope: string;
  setScope: (scope: string) => void;
  /** Bumped by the band's ↻ — refetches the index and every project scope. */
  refreshKey: number;
  refresh: () => void;
}

const Ctx = createContext<ConfigsScopeState | null>(null);

export function ConfigsScopeProvider({ active, children }: { active: boolean; children: ReactNode }) {
  const [scopeSel, setScope] = usePersistedState<string>('configs.scope', 'global');
  const [refreshKey, setRefreshKey] = useState(0);
  const { index, loading, error } = useConfigsIndex(refreshKey, active);

  const value = useMemo<ConfigsScopeState>(() => {
    const projects = index !== null ? index.projects : [];
    const known = scopeSel === 'global' || projects.some(p => p.dirName === scopeSel);
    return {
      index, loading, error,
      projects,
      scope: known ? scopeSel : 'global',
      setScope,
      refreshKey,
      refresh: () => setRefreshKey(k => k + 1)
    };
  }, [index, loading, error, scopeSel, setScope, refreshKey]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useConfigsScope(): ConfigsScopeState {
  const ctx = useContext(Ctx);
  if (ctx === null) throw new Error('useConfigsScope outside ConfigsScopeProvider');
  return ctx;
}

/** Rail row / band label for a scope id — 'global' has no ProjectRef. */
export function scopeLabel(scope: string, projects: ProjectRef[]): { name: string; path: string } {
  if (scope === 'global') return { name: 'Global', path: '~/.claude' };
  const hit = projects.find(p => p.dirName === scope);
  return hit !== undefined ? { name: hit.name, path: hit.path } : { name: scope, path: scope };
}
