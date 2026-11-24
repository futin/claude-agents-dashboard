/**
 * Command-line argument parsing shared by the `scripts/` audits.
 */

/**
 * `--days` as a positive whole number, `fallback` when the flag is absent. Anything else — `7d`, `0`, `-3`, `1.5`, the flag with no value, or the flag
 * followed by another `--flag` — prints why on stderr and exits 2 before the caller reads a transcript: `Number('7d')` is NaN, every window test against
 * NaN is false, and a run used to scan the whole history under a "NaN days" header with an unchanged exit code.
 */
export function parseDays(fallback: number, argv: readonly string[] = process.argv): number {
  const i = argv.indexOf('--days');
  if (i === -1) return fallback;
  const raw: string | undefined = argv[i + 1];
  if (raw !== undefined && !raw.startsWith('--') && /^[1-9]\d*$/.test(raw)) return Number(raw);
  const got = raw === undefined || raw.startsWith('--') ? 'got nothing' : `got "${raw}"`;
  console.error(`--days must be a positive whole number, ${got}`);
  process.exit(2);
}
