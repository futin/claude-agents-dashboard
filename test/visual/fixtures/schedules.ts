/**
 * `GET /api/schedules` and `GET /api/schedules/runs` — six job files, one per state the ledger tells apart (drawn sorted by name):
 * - broken-job: a file that does not parse, so the row draws its error and no schedule.
 * - nightly-sync: a `claude` fan-out over the pins, installed, last run ok across both repos.
 * - pr-triage: a single-cwd `claude` job, installed, last run failed.
 * - prune-branches: a `shell` job, paused.
 * - weekly-report: a `claude` job running now.
 * - wsl-backup: a `shell` job for the other machine only.
 * The runs list carries one of each run state (running, ok, failed, lost, refused), newest first.
 */
import type { ScheduleJob, ScheduleJobRow, ScheduleRun, ScheduleRunsResponse, ScheduleStats, ScheduleStep, SchedulesResponse } from '../../../shared/types.js';

import { DAY, EPOCH, HOUR, MIN, SEC, agoIso, ago } from './epoch.js';
import { HOME, PROJECTS, SESSION_IDS } from './sessions.js';

const DIR = `${HOME}/claude-global/schedules`;

function job(over: Partial<ScheduleJob> & Pick<ScheduleJob, 'name' | 'cron' | 'run'>): ScheduleJob {
  return {
    machines: ['mac'],
    foreach: null,
    cwd: null,
    enabled: true,
    model: null,
    effort: null,
    permissionMode: null,
    allowedTools: null,
    maxTurns: null,
    timeoutMs: 30 * MIN,
    body: '',
    script: null,
    ...over
  };
}

function step(over: Partial<ScheduleStep> & Pick<ScheduleStep, 'index' | 'startedAt'>): ScheduleStep {
  return {
    repo: null,
    cwd: null,
    endedAt: null,
    outcome: null,
    ms: null,
    exit: null,
    why: null,
    tail: null,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
    turns: null,
    model: null,
    sessionId: null,
    ...over
  };
}

/** A claude step that finished `endAgo` before EPOCH after running `ms`. */
function claudeStep(index: number, repo: string | null, endAgo: number, ms: number, outcome: ScheduleStep['outcome'], extra: Partial<ScheduleStep> = {}): ScheduleStep {
  return step({
    index, repo, cwd: repo ? `${HOME}/code/${repo}` : `${HOME}/code/${PROJECTS.aurora.name}`,
    startedAt: agoIso(endAgo + ms), endedAt: agoIso(endAgo), outcome, ms, exit: outcome === 'ok' ? 0 : 1,
    costUsd: 0.42 + index * 0.17, tokensIn: 184_200 + index * 21_000, tokensOut: 6_400 + index * 900, turns: 14 + index * 3, model: 'claude-sonnet-5-5',
    ...extra
  });
}

function run(over: Partial<ScheduleRun> & Pick<ScheduleRun, 'id' | 'job' | 'startedAt' | 'state'>): ScheduleRun {
  return {
    machine: 'mac',
    trigger: 'schedule',
    endedAt: null,
    ms: null,
    late: false,
    ok: 0,
    failed: 0,
    skipped: 0,
    total: 1,
    stopped: false,
    error: null,
    why: null,
    steps: [],
    ...over
  };
}

const weeklyRunning = run({
  id: 'b1f0c2d3-0001-4a00-8000-000000000001', job: 'weekly-report', startedAt: agoIso(4 * MIN), state: 'running', total: 1,
  steps: [step({ index: 0, cwd: PROJECTS.aurora.path, startedAt: agoIso(4 * MIN), model: 'claude-sonnet-5-5', sessionId: SESSION_IDS.working })]
});

const prTriageFailed = run({
  id: 'b1f0c2d3-0002-4a00-8000-000000000002', job: 'pr-triage', startedAt: agoIso(30 * MIN), endedAt: agoIso(25 * MIN), ms: 5 * MIN, state: 'failed', failed: 1,
  steps: [claudeStep(0, null, 25 * MIN, 5 * MIN, 'failed', {
    why: 'max turns reached', tail: 'Reviewed 3 of 5 open PRs\nStopped: --max-turns 20 reached before the summary was written', sessionId: SESSION_IDS.idle
  })]
});

const nightlyOk = run({
  id: 'b1f0c2d3-0003-4a00-8000-000000000003', job: 'nightly-sync', startedAt: agoIso(11 * HOUR), endedAt: agoIso(10 * HOUR + 51 * MIN), ms: 9 * MIN,
  state: 'ok', ok: 2, total: 2,
  steps: [
    claudeStep(0, PROJECTS.aurora.name, 10 * HOUR + 56 * MIN, 4 * MIN, 'ok', { sessionId: SESSION_IDS.question }),
    claudeStep(1, PROJECTS.harbor.name, 10 * HOUR + 51 * MIN, 5 * MIN, 'ok', { sessionId: SESSION_IDS.incomplete })
  ]
});

const nightlyLost = run({
  id: 'b1f0c2d3-0004-4a00-8000-000000000004', job: 'nightly-sync', startedAt: agoIso(DAY + 11 * HOUR), state: 'lost', ok: 1, total: 2,
  why: 'wrapper gone, no end record',
  steps: [claudeStep(0, PROJECTS.aurora.name, DAY + 10 * HOUR + 56 * MIN, 4 * MIN, 'ok')]
});

const pruneRefused = run({
  id: `refused-mac-prune-branches-${ago(2 * DAY + 5 * HOUR)}`, job: 'prune-branches', startedAt: agoIso(2 * DAY + 5 * HOUR), endedAt: agoIso(2 * DAY + 5 * HOUR), ms: 0, state: 'refused',
  total: 0, why: 'previous run still holds the lock'
});

const pruneOk = run({
  id: 'b1f0c2d3-0005-4a00-8000-000000000005', job: 'prune-branches', startedAt: agoIso(9 * DAY + 2 * MIN), endedAt: agoIso(9 * DAY), ms: 2 * MIN,
  state: 'ok', ok: 1, trigger: 'manual',
  steps: [step({
    index: 0, cwd: PROJECTS.harbor.path, startedAt: agoIso(9 * DAY + 2 * MIN), endedAt: agoIso(9 * DAY), outcome: 'ok', ms: 2 * MIN, exit: 0,
    tail: 'Deleted branch feat/old-sidebar (was 3c4d5e6).\nDeleted branch fix/flaky-ci (was 7a8b9c0).'
  })]
});

const NIGHTLY = job({
  name: 'nightly-sync', cron: '0 3 * * *', run: 'claude', foreach: 'pinned', model: 'claude-sonnet-5-5', permissionMode: 'acceptEdits', maxTurns: 40,
  body: 'Sync this repo with its upstream and summarise what changed.'
});
const PR_TRIAGE = job({
  name: 'pr-triage', cron: '*/30 9-18 * * 1-5', run: 'claude', cwd: PROJECTS.aurora.path, model: 'claude-sonnet-5-5', permissionMode: 'plan', maxTurns: 20,
  body: 'Triage the open pull requests and label each one.'
});
const PRUNE = job({
  name: 'prune-branches', cron: '0 9 * * 1', run: 'shell', cwd: PROJECTS.harbor.path, enabled: false, timeoutMs: 5 * MIN,
  body: '```bash\ngit fetch --prune && git branch --merged main | grep -v main | xargs -r git branch -d\n```',
  script: 'git fetch --prune && git branch --merged main | grep -v main | xargs -r git branch -d'
});
const WEEKLY = job({
  name: 'weekly-report', cron: '0 14 * * 3', run: 'claude', cwd: PROJECTS.aurora.path, model: 'claude-sonnet-5-5', effort: 'high',
  body: 'Write the weekly report from the merged pull requests.'
});
const WSL_BACKUP = job({
  name: 'wsl-backup', cron: '30 2 * * *', run: 'shell', machines: ['wsl'], cwd: '~/backups', body: '```bash\n./backup.sh\n```', script: './backup.sh'
});

const MTIME = ago(3 * DAY);

/** A ledger row; `text` is a plausible file, never parsed by the client for these shots. */
function row(j: ScheduleJob, over: Partial<ScheduleJobRow> = {}): ScheduleJobRow {
  return {
    name: j.name,
    text: `---\ncron: "${j.cron}"\nrun: ${j.run}\n---\n${j.body}\n`,
    job: j,
    errors: [],
    mtimeMs: MTIME,
    onThisMachine: j.machines.includes('mac'),
    installed: j.enabled && j.machines.includes('mac'),
    nextAt: null,
    last: null,
    running: null,
    ...over
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

export const schedules: SchedulesResponse = {
  machine: 'mac',
  dir: DIR,
  owner: 'owner',
  reconcile: { state: 'in-sync', changes: [], unchanged: 3, error: null, at: agoIso(2 * MIN) },
  jobs: [
    row(job({ name: 'broken-job', cron: '', run: 'shell' }), {
      text: '---\ncron: every morning\nrun: shell\n---\n',
      job: null,
      errors: [{ line: 2, message: 'cron: expected five fields, got "every morning"' }],
      onThisMachine: false,
      installed: false
    }),
    row(NIGHTLY, { nextAt: iso(EPOCH + 13 * HOUR), last: nightlyOk }),
    row(PR_TRIAGE, { nextAt: iso(EPOCH + 3 * MIN), last: prTriageFailed }),
    row(PRUNE, { last: pruneRefused }),
    row(WEEKLY, { nextAt: iso(EPOCH + 7 * DAY), last: null, running: weeklyRunning }),
    row(WSL_BACKUP)
  ]
};

/** 30 UTC days ending on EPOCH's, oldest first, with a quiet weekend shape and a few failures. */
function byDay(): ScheduleStats['byDay'] {
  return Array.from({ length: 30 }, (_, i) => {
    const day = new Date(EPOCH - (29 - i) * DAY);
    const weekend = day.getUTCDay() === 0 || day.getUTCDay() === 6;
    const ok = weekend ? 1 : 3 + (i % 4);
    return { day: day.toISOString().slice(0, 10), ok, failed: i % 7 === 3 ? 1 : 0 };
  });
}

const days = byDay();

export const scheduleRuns: ScheduleRunsResponse = {
  runs: [weeklyRunning, prTriageFailed, nightlyOk, nightlyLost, pruneRefused, pruneOk],
  stats: {
    runs: days.reduce((n, d) => n + d.ok + d.failed, 0),
    ok: days.reduce((n, d) => n + d.ok, 0),
    failed: days.reduce((n, d) => n + d.failed, 0) - 1,
    lost: 1,
    costUsd: 38.17,
    tokensIn: 41_820_000,
    tokensOut: 1_264_000,
    wallMs: 14 * HOUR + 22 * MIN + 41 * SEC,
    byDay: days,
    prev: { costUsd: 31.4, runs: 88 }
  }
};
