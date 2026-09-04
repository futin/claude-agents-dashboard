/**
 * check-token-weights.ts — re-measure the assumption behind `TYPE_WEIGHTS.cc`.
 *
 *   tsx scripts/check-token-weights.ts [--root <projects dir>] [--days N]
 *
 * `cc` is the **1-hour** cache-write multiplier (2x) because this machine
 * writes 1-hour caches — 99.96% of cache-write tokens, measured 2026-09-02.
 * The ledger stores only the flat `cache_creation_input_tokens`, so nothing
 * downstream can tell the two TTL tiers apart; splitting them into a fifth
 * token type would change the on-disk line shape to distinguish 0.04% of the
 * tokens. This command is the cheaper guard: it re-derives the tier mix
 * straight from the transcripts and fails when the constant no longer follows
 * from it.
 *
 * It is not a check on the 5-hour subscription limit. Anthropic publishes no
 * per-token-type weighting for that limit; these are API list-price ratios
 * used as a proxy (`docs/subsystems/usage-limits.md`).
 *
 *   stdout   one table per model, plus warnings
 *   exit 0   the configured weights still follow from the data
 *   exit 1   some model with real evidence disagrees with the configured `cc`
 */

import fs from 'node:fs';

import { listTranscripts, projectsRoot } from '../server/lib/scan.js';
import { CHECKED_MODEL_PREFIXES, longestPrefixMatch, weightsFor } from '../server/lib/usage-ledger.js';

const DAY_MS = 86_400_000;

/** Published cache-write multipliers of base input, by TTL tier. */
const WRITE_5M = 1.25;
const WRITE_1H = 2;

/**
 * How far the measured blend may sit from the configured `cc` before this
 * fails. 0.05 of a multiplier is ~7% of the 0.75 span between the two tiers —
 * wide enough that a handful of stray 5m writes is noise, narrow enough that a
 * machine which has actually switched tiers cannot hide inside it.
 */
const TOLERANCE = 0.05;

/**
 * Cache-write tokens a model needs in the window before its blend is allowed
 * to fail the run. A model seen for one turn is a sample of one; it gets
 * reported, not enforced.
 */
const EVIDENCE_FLOOR = 1_000_000;

interface ModelStats {
  requests: number;
  /** Flat `cache_creation_input_tokens`, the field the ledger records. */
  flatCC: number;
  cc5m: number;
  cc1h: number;
  cr: number;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const ROOT = arg('root') ?? projectsRoot();
const DAYS = Number(arg('days') ?? 7);

function emptyStats(): ModelStats {
  return { requests: 0, flatCC: 0, cc5m: 0, cc1h: 0, cr: 0 };
}

/**
 * Every assistant turn on disk inside the window, folded per model.
 *
 * Deduplicated by `message.id` — the same rule the recorder and `sumWindow`
 * apply, because one assistant message is written into as many transcripts as
 * reference it and counting it twice would double that model's tokens.
 */
function collect(root: string, sinceMs: number): { stats: Map<string, ModelStats>; files: number } {
  const stats = new Map<string, ModelStats>();
  const seen = new Set<string>();
  let files = 0;
  for (const ref of listTranscripts(root)) {
    try {
      if (fs.statSync(ref.file).mtimeMs < sinceMs) continue;
    } catch { continue; }
    files++;
    let text: string;
    try { text = fs.readFileSync(ref.file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let rec: any;
      try { rec = JSON.parse(line); } catch { continue; }
      const msg = rec?.message;
      if (!msg || msg.role !== 'assistant' || !msg.usage) continue;
      const model = typeof msg.model === 'string' ? msg.model : '';
      if (!model) continue;
      const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : Number.NaN;
      if (!Number.isFinite(ts) || ts < sinceMs) continue;
      const id = typeof msg.id === 'string' ? msg.id : '';
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      const u = msg.usage;
      // `cache_creation` is absent on older-format lines. Their tokens are real
      // and belong in the flat total, but they carry no TTL — leaving both
      // buckets untouched is what keeps them out of the blend, rather than
      // defaulting them into the 5m tier and failing the run on their account.
      const nested = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : {};
      const s = stats.get(model) ?? stats.set(model, emptyStats()).get(model)!;
      s.requests++;
      s.flatCC += Number(u.cache_creation_input_tokens) || 0;
      s.cc5m += Number(nested.ephemeral_5m_input_tokens) || 0;
      s.cc1h += Number(nested.ephemeral_1h_input_tokens) || 0;
      s.cr += Number(u.cache_read_input_tokens) || 0;
    }
  }
  return { stats, files };
}

function pct(n: number, d: number): string {
  return d <= 0 ? '   n/a' : (100 * n / d).toFixed(2) + '%';
}

const sinceMs = Date.now() - DAYS * DAY_MS;
const { stats, files } = collect(ROOT, sinceMs);

console.log(`token-weight check — last ${DAYS} day(s) under ${ROOT}`);
console.log(`  transcripts read: ${files}`);
console.log('');

const models = [...stats.keys()].sort();
if (models.length === 0) {
  console.log('  no assistant messages with usage in the window — nothing to check.');
  process.exit(0);
}

const failures: string[] = [];
const warnings: string[] = [];

console.log('  model                              requests    cache-write     1h share   blended cc   configured');
for (const model of models) {
  const s = stats.get(model)!;
  const tiered = s.cc5m + s.cc1h;
  const configured = weightsFor(model).cc;
  const blended = tiered > 0 ? (WRITE_5M * s.cc5m + WRITE_1H * s.cc1h) / tiered : null;
  console.log(
    '  ' + model.padEnd(34)
    + String(s.requests).padStart(8)
    + s.flatCC.toLocaleString('en-US').padStart(15)
    + pct(s.cc1h, tiered).padStart(13)
    + (blended === null ? 'n/a' : blended.toFixed(4)).padStart(13)
    + configured.toFixed(4).padStart(13)
  );
  if (tiered > 0 && tiered < s.flatCC) {
    warnings.push(
      `${model}: ${(s.flatCC - tiered).toLocaleString('en-US')} cache-write tokens carry no TTL breakdown `
      + '(older transcript format); they are excluded from the blend.'
    );
  }
  if (blended !== null && tiered >= EVIDENCE_FLOOR && Math.abs(blended - configured) > TOLERANCE) {
    failures.push(
      `${model}: measured cache-write multiplier ${blended.toFixed(4)} but TYPE_WEIGHTS.cc is `
      + `${configured.toFixed(4)} (${tiered.toLocaleString('en-US')} tiered cache-write tokens, `
      + `${pct(s.cc1h, tiered)} at the 1h tier).`
    );
  }
  // Only models that carry priced volume. `<synthetic>` is Claude Code's
  // placeholder for messages it generated itself, not a model anyone can price.
  if (s.flatCC + s.cr > 0 && longestPrefixMatch(CHECKED_MODEL_PREFIXES, model) === undefined) {
    warnings.push(
      `${model}: not in CHECKED_MODEL_PREFIXES — its price ratios have never been checked, so it is `
      + 'being weighted with the uniform set. Price it and add the prefix.'
    );
  }
}
console.log('');

for (const w of warnings) console.log('  ! ' + w);
if (warnings.length > 0) console.log('');

if (failures.length > 0) {
  for (const f of failures) console.log('  ✗ ' + f);
  console.log('');
  console.log(`FAIL (${failures.length}) — see the provenance comment above TYPE_WEIGHTS in server/lib/usage-ledger.ts`);
  process.exit(1);
}

console.log('OK — the configured weights still follow from the transcripts.');
process.exit(0);
