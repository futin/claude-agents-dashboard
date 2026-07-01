'use strict';

/**
 * scan.js — enumerate Claude Code session transcripts under ~/.claude/projects,
 * parse the most-recent ones, and build the ranked session list.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { readTranscript } = require('./transcript');

/** Default transcripts root. */
function projectsRoot(homeDir) {
  return path.join(homeDir || os.homedir(), '.claude', 'projects');
}

/**
 * Best-effort human label for a project when no cwd is available: decode the
 * Claude Code directory name (`-a-b-c` → `a/b/c`) and take the basename.
 * Lossy (can't distinguish `/` from original `-`), so only a fallback.
 */
function decodeProjectName(dirName) {
  const decoded = String(dirName).replace(/^-/, '').replace(/-/g, '/');
  const base = decoded.split('/').filter(Boolean).pop();
  return base || dirName;
}

/** List every `.jsonl` transcript with its mtime, across all project dirs. */
function listTranscripts(root) {
  const results = [];
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      results.push({ file: full, dirName: d.name, id: name.replace(/\.jsonl$/, ''), mtimeMs: stat.mtimeMs });
    }
  }
  return results;
}

/** Count running `claude` processes (informational cross-check). */
function countClaudeProcesses() {
  try {
    const out = execFileSync('ps', ['-Ao', 'comm='], { encoding: 'utf8', timeout: 2000 });
    return out.split('\n').filter(l => /(^|\/)claude$/.test(l.trim())).length;
  } catch {
    return null;
  }
}

/**
 * Build the ranked session snapshot.
 * @param {object} config - { maxSessions, activeWindowMin, lookbackHours }
 * @param {object} [options] - { homeDir, now (ms), root }
 */
function scanSessions(config, options = {}) {
  const cfg = config || {};
  const maxSessions = cfg.maxSessions > 0 ? cfg.maxSessions : 5;
  const activeWindowMin = cfg.activeWindowMin > 0 ? cfg.activeWindowMin : 5;
  const lookbackHours = cfg.lookbackHours > 0 ? cfg.lookbackHours : 24;

  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const root = options.root || projectsRoot(options.homeDir);

  const lookbackMs = lookbackHours * 60 * 60 * 1000;
  const activeMs = activeWindowMin * 60 * 1000;

  const candidates = listTranscripts(root)
    .filter(t => now - t.mtimeMs <= lookbackMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxSessions);

  const sessions = [];
  for (const c of candidates) {
    const parsed = readTranscript(c.file);
    if (!parsed) continue;
    const projectPath = parsed.cwd || null;
    const project = projectPath ? (projectPath.split('/').filter(Boolean).pop() || projectPath) : decodeProjectName(c.dirName);
    const status = now - c.mtimeMs <= activeMs ? 'working' : 'idle';
    sessions.push({
      id: c.id,
      project,
      projectPath,
      gitBranch: parsed.gitBranch || null,
      model: parsed.model || '',
      tokens: parsed.tokens,
      contextWindow: parsed.contextWindow,
      contextWindowLabel: parsed.contextWindowLabel,
      contextPct: parsed.contextPct,
      status,
      activity: parsed.activity,
      lastTimestamp: parsed.lastTimestamp,
      updatedMs: c.mtimeMs,
      version: parsed.version || null
    });
  }

  return {
    generatedAt: new Date(now).toISOString(),
    activeWindowMin,
    maxSessions,
    runningClaudeProcs: options.skipProcScan ? null : countClaudeProcesses(),
    totals: {
      shown: sessions.length,
      active: sessions.filter(s => s.status === 'working').length
    },
    sessions
  };
}

module.exports = {
  projectsRoot,
  decodeProjectName,
  listTranscripts,
  countClaudeProcesses,
  scanSessions
};
