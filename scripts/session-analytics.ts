/**
 * session-analytics.ts — server-less CLI for the whole-session token/tool post-mortem.
 * Prints a SessionAnalysis as JSON to stdout so the `/kaizen` skill can read
 * exact numbers without assuming the dashboard server is running.
 *
 *   tsx scripts/session-analytics.ts <session-id>            resolve id under ~/.claude/projects
 *   tsx scripts/session-analytics.ts /abs/path/to/x.jsonl    analyze a transcript directly
 *   tsx scripts/session-analytics.ts --latest                newest transcript for the current cwd
 *
 * Id resolution mirrors serveSessionDetail (api.ts): the id is matched against
 * the enumerated transcript list, never joined into a path — so a hostile id
 * can't escape the projects root.
 */

import { analyzeSession } from '../server/lib/analyze.js';
import { listTranscripts, projectsRoot } from '../server/lib/scan.js';

/** Same guard as api.ts ID_RE, duplicated so the CLI doesn't import the HTTP layer. */
const ID_RE = /^[A-Za-z0-9._-]+$/;

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function normCwd(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

function main(): void {
  const arg = process.argv[2];
  if (!arg) {
    die('usage: tsx scripts/session-analytics.ts <session-id | /abs/path.jsonl | --latest>');
  }

  let file: string;
  let id: string | undefined;

  if (arg === '--latest') {
    const here = normCwd(process.cwd());
    // Newest transcript whose recorded cwd equals this process's cwd.
    const cands = listTranscripts(projectsRoot()).sort((a, b) => b.mtimeMs - a.mtimeMs);
    const match = cands.find(t => {
      const a = analyzeSession(t.file, t.id);
      return a && a.cwd && normCwd(a.cwd) === here;
    });
    if (!match) die(`no transcript found for cwd ${here}`);
    file = match.file;
    id = match.id;
    console.error(`[session-analytics] --latest resolved to session ${id}`);
  } else if (arg.startsWith('/')) {
    if (arg.includes('..') || !arg.endsWith('.jsonl')) die('path must be an absolute .jsonl file');
    file = arg;
  } else {
    if (!ID_RE.test(arg)) die('invalid session id');
    const ref = listTranscripts(projectsRoot()).find(t => t.id === arg);
    if (!ref) die(`session not found: ${arg}`);
    file = ref.file;
    id = ref.id;
  }

  const analysis = analyzeSession(file, id);
  if (!analysis) die(`could not read transcript: ${file}`);
  process.stdout.write(JSON.stringify(analysis, null, 2) + '\n');
}

main();
