/** Display formatters for the dashboard. (React escapes text, so no esc().) */

/** Compact token count: 1.2M, 3.4k, 500. */
export function fmtTok(n: number): string {
  // Round before picking the unit: 999_999 is "1.00M", not "1000.0k".
  const k = (n / 1e3).toFixed(1);
  if (n >= 1e6 || Number(k) >= 1e3) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return k + 'k';
  return String(n || 0);
}

/** Compact file size: 0 B, 1023 B, 15.1 KB, 2.5 MB. */
export function fmtBytes(n: number): string {
  // Same rule as fmtTok: 1048575 is "1.0 MB", not "1024.0 KB".
  const kb = (n / 1024).toFixed(1);
  if (n >= 1024 * 1024 || Number(kb) >= 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  if (n >= 1024) return kb + ' KB';
  return (n || 0) + ' B';
}

/** Compact elapsed duration in ms: 900ms, 12s, 1m30s, 2h5m. */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (Math.round(ms) < 1000) return Math.round(ms) + 'ms';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + (s % 60 ? (s % 60) + 's' : '');
  const h = Math.floor(m / 60);
  return h + 'h' + (m % 60 ? (m % 60) + 'm' : '');
}

/** Relative age of an epoch-ms timestamp against a caller-supplied now: 5s, 3m, 2h, 1d. A timestamp in the future reads 0s. */
export function ageAt(ms: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (s < 60) return s + 's';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h';
  return Math.round(h / 24) + 'd';
}

/** Relative age of an epoch-ms timestamp against the clock: 5s, 3m, 2h, 1d. */
export function formatAgo(ms: number): string {
  return ageAt(ms, Date.now());
}

/** Reset clock time for a usage window: 2:14pm (today), or Thu 2:14pm (later). */
export function formatResetTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase().replace(' ', '');
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return time;
  return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
}
