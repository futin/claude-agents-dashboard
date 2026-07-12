import { useEffect, useRef, useState } from 'react';

import type { FileContent, ManagementIndex, ScopeConfig } from '../../../shared/types';

/**
 * Management data hooks. No polling anywhere: config changes on the order of
 * days (the 3s pattern exists because *sessions* are live). The index is
 * fetched once per mount / refresh bump; project scopes and file contents are
 * fetched lazily on selection and memoized in ref-held Maps.
 */

export interface IndexState {
  index: ManagementIndex | null;
  loading: boolean;
  error: boolean;
}

export function useManagementIndex(refreshKey: number): IndexState {
  const [state, setState] = useState<IndexState>({ index: null, loading: true, error: false });

  useEffect(() => {
    let alive = true;
    setState(prev => ({ index: prev.index, loading: true, error: false }));
    fetch('/api/management')
      .then(res => res.json() as Promise<ManagementIndex>)
      .then(index => {
        if (alive) setState({ index, loading: false, error: index.error === true });
      })
      .catch(() => {
        if (alive) setState(prev => ({ index: prev.index, loading: false, error: true }));
      });
    return () => { alive = false; };
  }, [refreshKey]);

  return state;
}

export function useProjectScope(dirName: string | null, refreshKey: number): ScopeConfig | null {
  const cache = useRef(new Map<string, ScopeConfig>());
  const [, force] = useState(0);

  const key = dirName === null ? null : `${refreshKey}:${dirName}`;

  useEffect(() => {
    if (key === null || dirName === null || cache.current.has(key)) return;
    let alive = true;
    fetch(`/api/management/project?dir=${encodeURIComponent(dirName)}`)
      .then(res => res.json() as Promise<ScopeConfig>)
      .then(scope => {
        if (!alive) return;
        cache.current.set(key, scope);
        force(n => n + 1);
      })
      .catch(() => { /* leave uncached; refresh retries */ });
    return () => { alive = false; };
  }, [key, dirName]);

  return key === null ? null : cache.current.get(key) ?? null;
}

export interface FileState {
  file: FileContent | null;
  loading: boolean;
  error: boolean;
}

export function useFileContent(path: string | null): FileState {
  const cache = useRef(new Map<string, FileContent>());
  const [state, setState] = useState<FileState>({ file: null, loading: false, error: false });

  useEffect(() => {
    if (path === null) {
      setState({ file: null, loading: false, error: false });
      return;
    }
    const hit = cache.current.get(path);
    if (hit) {
      setState({ file: hit, loading: false, error: false });
      return;
    }
    let alive = true;
    setState({ file: null, loading: true, error: false });
    fetch(`/api/management/file?path=${encodeURIComponent(path)}`)
      .then(res => res.json() as Promise<FileContent>)
      .then(file => {
        if (!alive) return;
        if (file.error === true) {
          setState({ file: null, loading: false, error: true });
        } else {
          cache.current.set(path, file);
          setState({ file, loading: false, error: false });
        }
      })
      .catch(() => {
        if (alive) setState({ file: null, loading: false, error: true });
      });
    return () => { alive = false; };
  }, [path]);

  return state;
}
