import fs from 'node:fs';

interface WatchOptions {
  /** 0-based index of the watched `readSync` that throws instead of reading; none when absent. */
  failAt?: number;
  /** Called with each watched read's byte count, as it happens. */
  onRead?: (bytes: number) => void;
}

/**
 * Wraps the default `node:fs` export, which is the object `jsonl-tail.ts` reads through, until `restore` runs: counts the bytes `fs.readSync` returned for
 * fds opened on a path `watch` accepts (an fd is attributed to a path at `openSync`), and with `failAt` makes that watched `readSync` throw instead.
 */
function installWatch(watch: (p: string) => boolean, opts: WatchOptions): { stats: { bytes: number }; restore: () => void } {
  const origOpen = fs.openSync, origRead = fs.readSync, origClose = fs.closeSync;
  const watched = new Set<number>();
  const stats = { bytes: 0 };
  let reads = 0;
  const f = fs as any;
  f.openSync = (...args: any[]) => {
    const fd = (origOpen as any)(...args);
    if (watch(String(args[0]))) watched.add(fd);
    return fd;
  };
  f.readSync = (...args: any[]) => {
    if (watched.has(args[0]) && reads++ === opts.failAt) throw new Error('injected read failure');
    const n = (origRead as any)(...args);
    if (watched.has(args[0])) { stats.bytes += n; opts.onRead?.(n); }
    return n;
  };
  f.closeSync = (fd: number) => { watched.delete(fd); return origClose(fd); };
  return { stats, restore: () => { f.openSync = origOpen; f.readSync = origRead; f.closeSync = origClose; } };
}

function withWatchedReads<T>(fn: () => T, watch: (p: string) => boolean, opts: WatchOptions): { result: T; bytes: number } {
  const w = installWatch(watch, opts);
  try { const result = fn(); return { result, bytes: w.stats.bytes }; }
  finally { w.restore(); }
}

async function withWatchedReadsAsync<T>(fn: () => Promise<T>, watch: (p: string) => boolean, opts: WatchOptions): Promise<{ result: T; bytes: number }> {
  const w = installWatch(watch, opts);
  try { const result = await fn(); return { result, bytes: w.stats.bytes }; }
  finally { w.restore(); }
}

/** Bytes `fs.readSync` returned for paths `watch` accepts while `fn` ran. */
export function bytesRead<T>(fn: () => T, watch: (p: string) => boolean): { result: T; bytes: number } {
  return withWatchedReads(fn, watch, {});
}

/** Runs `fn` with the first `fs.readSync` on a path `watch` accepts throwing; what `fn` throws propagates. */
export function withReadFaultOnce<T>(fn: () => T, watch: (p: string) => boolean): T {
  return withWatchedReads(fn, watch, { failAt: 0 }).result;
}

/** {@link bytesRead} over everything `fn`'s promise does until it settles; `onRead` sees each watched read as it happens. */
export function bytesReadAsync<T>(
  fn: () => Promise<T>, watch: (p: string) => boolean, onRead?: (bytes: number) => void
): Promise<{ result: T; bytes: number }> {
  return withWatchedReadsAsync(fn, watch, { onRead });
}

/** Runs `fn` until its promise settles, with the watched `fs.readSync` number `failAt` (0-based) throwing; what `fn` rejects with propagates. */
export async function withReadFaultAsync<T>(fn: () => Promise<T>, watch: (p: string) => boolean, failAt: number): Promise<T> {
  return (await withWatchedReadsAsync(fn, watch, { failAt })).result;
}
