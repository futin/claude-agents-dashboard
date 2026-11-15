/**
 * atomic-write.ts — replace a state file whole or not at all. The data goes to a temp file in the same directory, then `rename` swaps it in: a crash,
 * a kill or ENOSPC partway through leaves the old file intact, where a write straight onto the target leaves it truncated. Same directory on purpose —
 * rename is atomic only within one filesystem, and the Docker state dir is a named volume.
 */
import fs from 'node:fs';

let renameOverride: ((from: string, to: string) => void) | null = null;

/** Test seam: replace the rename step, so a case can fail the swap after the temp file is written. Null restores `fs.renameSync`. */
export function overrideAtomicRename(fn: ((from: string, to: string) => void) | null): void {
  renameOverride = fn;
}

/** Write `data` to `file` atomically. On any failure the temp file is removed and the error rethrown; the caller keeps its own fallback. */
export function writeFileAtomic(file: string, data: string | Buffer): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    (renameOverride ?? fs.renameSync)(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    throw e;
  }
}
