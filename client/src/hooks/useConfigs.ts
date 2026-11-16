import { useEffect, useRef, useState } from 'react';

import { projectScopeOf } from '../lib/configsEntries';
import type { FileContent, ManagementIndex, ScopeConfig } from '../../../shared/types';

/**
 * Claude Configs data hooks. No polling anywhere: config changes on the order of
 * days (the 3s pattern exists because *sessions* are live). The index is
 * fetched once per mount / refresh bump; project scopes and file contents are
 * fetched lazily on selection and memoized in ref-held Maps.
 */

export interface IndexState {
  index: ManagementIndex | null;
  loading: boolean;
  error: boolean;
}

/**
 * `active` is the Claude Configs section being open. The index now feeds the
 * *rail's* scope tree as well as the page, so the hook is mounted for the whole
 * app life (see hooks/useConfigsScope.tsx) — without the flag every visitor
 * to Sessions would fetch a config scan they never look at.
 */
export function useConfigsIndex(refreshKey: number, active = true): IndexState {
  const [state, setState] = useState<IndexState>({ index: null, loading: true, error: false });

  useEffect(() => {
    if (!active) return;
    let alive = true;
    setState(prev => ({ index: prev.index, loading: true, error: false }));
    fetch('/api/configs')
      .then(res => res.json() as Promise<ManagementIndex>)
      .then(index => {
        if (alive) setState({ index, loading: false, error: index.error === true });
      })
      .catch(() => {
        if (alive) setState(prev => ({ index: prev.index, loading: false, error: true }));
      });
    return () => { alive = false; };
  }, [refreshKey, active]);

  return state;
}

export function useProjectScope(dirName: string | null, refreshKey: number): ScopeConfig | null {
  const cache = useRef(new Map<string, ScopeConfig>());
  // The last scope read per dir: ↻ shows it until the new read lands, or the list and the open file would unmount and flash empty.
  const latest = useRef(new Map<string, ScopeConfig>());
  const [, force] = useState(0);

  const key = dirName === null ? null : `${refreshKey}:${dirName}`;

  useEffect(() => {
    if (key === null || dirName === null || cache.current.has(key)) return;
    let alive = true;
    // A failure is cached like a scope, flagged `error`, so the view says so instead of "loading scope…" forever; ↻ changes the key and retries.
    fetch(`/api/configs/project?dir=${encodeURIComponent(dirName)}`)
      .then(async res => projectScopeOf(res.ok, await res.json().catch(() => undefined)), () => projectScopeOf(false, undefined))
      .then(scope => {
        if (!alive) return;
        cache.current.set(key, scope);
        latest.current.set(dirName, scope);
        force(n => n + 1);
      });
    return () => { alive = false; };
  }, [key, dirName]);

  return key === null || dirName === null ? null : cache.current.get(key) ?? latest.current.get(dirName) ?? null;
}

export interface FileState {
  file: FileContent | null;
  loading: boolean;
  error: boolean;
}

/**
 * One file's text for a FileBlock, cached per `${refreshKey}:${path}` the way `useProjectScope` keys its scopes, so ↻ (which bumps `refreshKey`) refetches
 * the file that is open. While that refetch is out the old text stays in `file` beside `loading: true`, so the block does not flash empty.
 */
export function useFileContent(path: string | null, refreshKey = 0): FileState {
  const cache = useRef(new Map<string, FileContent>());
  const shownPath = useRef<string | null>(null);
  const [state, setState] = useState<FileState>({ file: null, loading: false, error: false });

  useEffect(() => {
    if (path === null) {
      shownPath.current = null;
      setState({ file: null, loading: false, error: false });
      return;
    }
    const key = `${refreshKey}:${path}`;
    const samePath = shownPath.current === path;
    shownPath.current = path;
    const hit = cache.current.get(key);
    if (hit) {
      setState({ file: hit, loading: false, error: false });
      return;
    }
    let alive = true;
    setState(prev => ({ file: samePath ? prev.file : null, loading: true, error: false }));
    fetch(`/api/configs/file?path=${encodeURIComponent(path)}`)
      .then(res => res.json() as Promise<FileContent>)
      .then(file => {
        if (!alive) return;
        if (file.error === true) {
          setState({ file: null, loading: false, error: true });
        } else {
          cache.current.set(key, file);
          setState({ file, loading: false, error: false });
        }
      })
      .catch(() => {
        if (alive) setState({ file: null, loading: false, error: true });
      });
    return () => { alive = false; };
  }, [path, refreshKey]);

  return state;
}
