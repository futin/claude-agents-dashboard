import fs from 'node:fs';

/**
 * Wraps the default `node:fs` export, which is the object `jsonl-tail.ts` reads through, while `fn` runs: counts the bytes `fs.readSync` returned for fds
 * opened on a path `watch` accepts (an fd is attributed to a path at `openSync`), and with `throwOnce` makes the first such `readSync` throw instead.
 */
function withWatchedReads<T>(fn: () => T, watch: (p: string) => boolean, throwOnce: boolean): { result: T; bytes: number } {
  const origOpen = fs.openSync, origRead = fs.readSync, origClose = fs.closeSync;
  const watched = new Set<number>();
  let bytes = 0;
  let armed = throwOnce;
  const f = fs as any;
  f.openSync = (...args: any[]) => {
    const fd = (origOpen as any)(...args);
    if (watch(String(args[0]))) watched.add(fd);
    return fd;
  };
  f.readSync = (...args: any[]) => {
    if (armed && watched.has(args[0])) { armed = false; throw new Error('injected read failure'); }
    const n = (origRead as any)(...args);
    if (watched.has(args[0])) bytes += n;
    return n;
  };
  f.closeSync = (fd: number) => { watched.delete(fd); return origClose(fd); };
  try { return { result: fn(), bytes }; }
  finally { f.openSync = origOpen; f.readSync = origRead; f.closeSync = origClose; }
}

/** Bytes `fs.readSync` returned for paths `watch` accepts while `fn` ran. */
export function bytesRead<T>(fn: () => T, watch: (p: string) => boolean): { result: T; bytes: number } {
  return withWatchedReads(fn, watch, false);
}

/** Runs `fn` with the first `fs.readSync` on a path `watch` accepts throwing; what `fn` throws propagates. */
export function withReadFaultOnce<T>(fn: () => T, watch: (p: string) => boolean): T {
  return withWatchedReads(fn, watch, true).result;
}
