/** Display formatters for the dashboard. (React escapes text, so no esc().) */

/** Compact token count: 1.2M, 3.4k, 500. */
export function fmtTok(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n || 0);
}

/** Compact elapsed duration in ms: 900ms, 12s, 1m30s, 2h5m. */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return Math.round(ms) + 'ms';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + (s % 60 ? (s % 60) + 's' : '');
  const h = Math.floor(m / 60);
  return h + 'h' + (m % 60 ? (m % 60) + 'm' : '');
}

/** Relative age of an epoch-ms timestamp: 5s, 3m, 2h, 1d. */
export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return s + 's';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h';
  return Math.round(h / 24) + 'd';
}
