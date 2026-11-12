/**
 * tool-output-replay.ts — server-less CLI over server/lib/tool-output-replay.ts: replays every transcript under ~/.claude/projects (main sessions and
 * their subagents) and prints what each tool poured into context, and what a read-guard and a bash-trim hook would have removed at each threshold.
 *
 *   tsx scripts/tool-output-replay.ts                         last 30 days, thresholds 4,8,16 KB, markdown
 *   tsx scripts/tool-output-replay.ts --days 7 --project backlog-manager --thresholds 8,16,32 --json
 *
 * --days filters by file mtime. --project matches a substring of the encoded project directory name. Files over --max-file-mb (default 512) are skipped
 * and counted, since the whole file is read into memory.
 */

import fs from 'node:fs';
import path from 'node:path';

import { projectsRoot } from '../server/lib/scan.js';
import { extractResults, simulate, type ResultRow, type ReplaySummary } from '../server/lib/tool-output-replay.js';

interface Args { days: number; project: string | null; thresholds: number[]; json: boolean; maxFileMb: number; root: string }

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const a: Args = { days: 30, project: null, thresholds: [4096, 8192, 16384], json: false, maxFileMb: 512, root: projectsRoot() };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    const need = (): string => { if (v === undefined) die(`${k} needs a value`); i++; return v; };
    if (k === '--days') a.days = Number(need());
    else if (k === '--project') a.project = need();
    else if (k === '--thresholds') a.thresholds = need().split(',').map(s => Math.round(Number(s) * 1024));
    else if (k === '--max-file-mb') a.maxFileMb = Number(need());
    else if (k === '--root') a.root = need();
    else if (k === '--json') a.json = true;
    else die(`unknown argument ${k}\nusage: tsx scripts/tool-output-replay.ts [--days N] [--project substr] [--thresholds 4,8,16] [--max-file-mb N] [--json]`);
  }
  if (!Number.isFinite(a.days) || a.days <= 0) die('--days must be a positive number');
  if (a.thresholds.some(n => !Number.isFinite(n) || n <= 0)) die('--thresholds must be positive KB values, comma-separated');
  a.thresholds.sort((x, y) => x - y);
  return a;
}

/** Every *.jsonl under one project directory: the session transcripts at its top level and each session's subagents/agent-*.jsonl. */
function* transcripts(projectDir: string): Generator<{ file: string; scope: 'main' | 'subagent' }> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(projectDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(projectDir, e.name);
    if (e.isFile() && e.name.endsWith('.jsonl')) yield { file: p, scope: 'main' };
    else if (e.isDirectory()) {
      const sub = path.join(p, 'subagents');
      let names: string[] = [];
      try { names = fs.readdirSync(sub); } catch { continue; }
      for (const n of names) if (n.endsWith('.jsonl')) yield { file: path.join(sub, n), scope: 'subagent' };
    }
  }
}

const KB = 1024, MB = 1024 * 1024;
const mb = (b: number): string => (b / MB).toFixed(1);
const pct = (part: number, whole: number): string => (whole > 0 ? (100 * part / whole).toFixed(1) : '0.0') + ' %';
/** Byte-turns as approximate cache-read tokens, millions (4 bytes per token). */
const mtok = (byteTurns: number): string => (byteTurns / 4 / 1e6).toFixed(1);

function markdown(s: ReplaySummary, meta: Record<string, number | string>, thresholds: number[]): string {
  const out: string[] = [];
  out.push('# Tool-output replay', '');
  out.push(`Corpus: ${meta.files} transcripts (${meta.mainFiles} main, ${meta.subFiles} subagent) modified in the last ${meta.days} days` +
    (meta.project ? `, project matching "${meta.project}"` : '') + (Number(meta.skipped) > 0 ? `; ${meta.skipped} skipped as too large` : '') + '.');
  out.push(`${s.totals.calls} tool results, ${mb(s.totals.bytes)} MB seen by the model, replayed into ≈ ${mtok(s.totals.byteTurns)} M cache-read tokens ` +
    `(bytes × later turns before a compaction, ÷ 4).`, '');

  const ths = thresholds.map(n => `> ${n / KB} KB`);
  out.push('## By tool (top 15 by replay weight)', '');
  out.push(`| Tool | Calls | MB | Replay Mtok | Share | ${ths.join(' | ')} |`);
  out.push(`|---|---:|---:|---:|---:|${thresholds.map(() => '---:').join('|')}|`);
  for (const t of s.byTool.slice(0, 15)) {
    const over = thresholds.map(n => `${t.over[n].calls} (${mb(t.over[n].bytes)} MB)`);
    out.push(`| ${t.tool} | ${t.calls} | ${mb(t.bytes)} | ${mtok(t.byteTurns)} | ${pct(t.byteTurns, s.totals.byteTurns)} | ${over.join(' | ')} |`);
  }
  out.push('', 'Over-columns: calls whose result is over the threshold (their MB).', '');

  out.push('## read-guard: deny a whole-file Read over the threshold', '');
  out.push('| Threshold | Denied calls | Saved MB (gross) | Saved MB (net of a ranged re-read) | Replay Mtok saved | Share of all replay |');
  out.push('|---:|---:|---:|---:|---:|---:|');
  for (const g of s.readGuard) {
    out.push(`| ${g.threshold / KB} KB | ${g.calls} | ${mb(g.savedBytes)} | ${mb(g.savedBytesNet)} | ${mtok(g.savedByteTurns)} | ${pct(g.savedByteTurns, s.totals.byteTurns)} |`);
  }
  out.push('', 'Net assumes each denied Read is followed by a ranged Read of up to the threshold — the conservative figure.', '');

  out.push('## bash-trim: keep 40 head + 40 tail lines of a Bash result over the threshold', '');
  out.push('| Threshold | Trimmed calls | Saved MB | Replay Mtok saved | Share of all replay |');
  out.push('|---:|---:|---:|---:|---:|');
  for (const g of s.bashTrim) {
    out.push(`| ${g.threshold / KB} KB | ${g.calls} | ${mb(g.savedBytes)} | ${mtok(g.savedByteTurns)} | ${pct(g.savedByteTurns, s.totals.byteTurns)} |`);
  }
  out.push('', 'Not modelled: a trimmed or denied call the model then has to re-run or grep for (beyond the ranged re-read above), and answer quality.', '');

  const bashTotal = s.bashByKind.reduce((sum, k) => sum + k.byteTurns, 0);
  const trimTotal = (n: number): number => s.bashByKind.reduce((sum, k) => sum + k.trimSavedByteTurns[n], 0);
  out.push('## Bash by command kind', '');
  out.push(`| Kind | Calls | MB | Share of Bash replay | ${thresholds.map(n => `Share of trim saving at ${n / KB} KB`).join(' | ')} |`);
  out.push(`|---|---:|---:|---:|${thresholds.map(() => '---:').join('|')}|`);
  for (const k of s.bashByKind) {
    out.push(`| ${k.kind} | ${k.calls} | ${mb(k.bytes)} | ${pct(k.byteTurns, bashTotal)} | ${thresholds.map(n => pct(k.trimSavedByteTurns[n], trimTotal(n))).join(' | ')} |`);
  }
  out.push('', 'Kind is judged from the command text, first match wins, file reads first: a chained `grep …; sed -n …` counts as a read. A trim that lands',
    'on the read kinds cuts the middle out of a file the model asked for.');
  return out.join('\n');
}

function main(): void {
  const a = parseArgs(process.argv.slice(2));
  const since = Date.now() - a.days * 86_400_000;
  const rows: ResultRow[] = [];
  let files = 0, mainFiles = 0, subFiles = 0, skipped = 0;

  let dirs: string[] = [];
  try { dirs = fs.readdirSync(a.root); } catch { die(`cannot read ${a.root}`); }
  for (const d of dirs) {
    if (a.project && !d.includes(a.project)) continue;
    for (const { file, scope } of transcripts(path.join(a.root, d))) {
      let st: fs.Stats;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs < since) continue;
      if (st.size > a.maxFileMb * MB) { skipped++; continue; }
      let text: string;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      for (const r of extractResults(text, { scope })) rows.push(r);
      files++;
      if (scope === 'main') mainFiles++; else subFiles++;
      if (files % 500 === 0) process.stderr.write(`… ${files} transcripts\n`);
    }
  }

  const summary = simulate(rows, a.thresholds);
  const meta = { files, mainFiles, subFiles, skipped, days: a.days, project: a.project ?? '' };
  if (a.json) {
    const subagent = simulate(rows.filter(r => r.scope === 'subagent'), a.thresholds);
    console.log(JSON.stringify({
      meta, thresholds: a.thresholds, summary,
      subagentOnly: { totals: subagent.totals, readGuard: subagent.readGuard, bashTrim: subagent.bashTrim, bashByKind: subagent.bashByKind }
    }, null, 2));
  } else {
    console.log(markdown(summary, meta, a.thresholds));
  }
}

main();
