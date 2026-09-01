/**
 * env-value.ts — print one `.env` key exactly the way the server reads it.
 *
 *   tsx scripts/env-value.ts <KEY> [--env <path>]
 *
 * Exists because `scripts/install-hooks.sh` used to parse `.env` itself, with a
 * `grep -E '^KEY=' | head -1 | cut -d= -f2- | tr -d "\"' \r"` pipeline, while the
 * server parsed the same file with `parseEnv`. Two readers, one file, three
 * measured disagreements: a leading space made the installer see nothing, `tr -d`
 * ate the spaces *inside* a quoted value, and `head -1` took the first of a
 * duplicated key where `parseEnv` takes the last. Each one wrote no
 * `~/.claude/hooks/dashboard-token` or a wrong one, so every hook POST came back
 * 403 while the dashboard looked healthy (backlog bug-6).
 *
 * The fix is not a better pipeline — it is having only one reader. This is it:
 * shell asks, `parseEnv` answers.
 *
 *   stdout   the value, with no trailing newline, and nothing else ever
 *   stderr   which source won, never the value itself
 *   exit 0   a non-empty value
 *   exit 1   the key is unset or empty (a normal answer, not a failure)
 *   exit 2   called wrong — no key given
 *
 * Splitting exit 1 from exit 2 is what keeps the original bug from coming back
 * in a new shape: a caller must be able to tell "there is no token" from "you
 * ran me wrong", because silently reporting the first when the second happened
 * is precisely how a configured token went missing for twelve hours.
 *
 * Values are trimmed, mirroring `loadConfig`, which trims every string field it
 * builds. It does not reproduce the few per-field extras `loadConfig` applies on
 * top (`NTFY_SERVER` and `DASHBOARD_PUBLIC_URL` also lose trailing slashes) — a
 * generic key reader cannot know them. For `ANSWER_TOKEN`, the key the installer
 * asks for, trim is the whole of it.
 */

import fs from 'node:fs';
import path from 'node:path';

import { parseEnv } from '../server/lib/config.js';

function usage(message: string): never {
  process.stderr.write(`env-value: ${message}\n`);
  process.stderr.write('usage: tsx scripts/env-value.ts <KEY> [--env <path>]\n');
  process.exit(2);
}

const argv = process.argv.slice(2);
let key = '';
let envPath = path.join(process.cwd(), '.env');

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--env') {
    const next = argv[++i];
    if (next === undefined) usage('--env needs a path');
    envPath = path.resolve(next);
  } else if (arg.startsWith('-')) {
    usage(`unknown option: ${arg}`);
  } else if (key === '') {
    key = arg;
  } else {
    usage('one key at a time');
  }
}

if (key === '') usage('no key given');

// A missing .env is the ordinary case on a fresh checkout, not an error: the
// key may still be exported in the environment, and if it isn't, "unset" is the
// honest answer.
let fileEnv: Record<string, string> = {};
try {
  fileEnv = parseEnv(fs.readFileSync(envPath, 'utf8'));
} catch {
  /* no .env — fall through to process.env */
}

const fromShell = process.env[key];
const source = fromShell !== undefined ? 'process.env' : envPath;
const value = (fromShell !== undefined ? fromShell : fileEnv[key] ?? '').trim();

if (value === '') {
  process.stderr.write(`env-value: ${key} unset (checked process.env and ${envPath})\n`);
  process.exit(1);
}

process.stderr.write(`env-value: ${key} from ${source}\n`);
process.stdout.write(value);
