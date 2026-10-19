/**
 * `GET /api/codegraph` — seven pins, one per state the CodeGraph layouts tell apart (drawn in the order harbor-web, lumen-cli, aurora-api, beacon, tidepool, old-scripts, notes):
 * - harbor-web: needs you, heaviest (two problems). A partial index, and the last sync failed.
 * - lumen-cli: needs you. Built by extractor v26 while v27 is current, so `reindexRecommended`; a watcher runs.
 * - aurora-api: worth a look. 7 files pending with no watcher, and the index was built from another worktree.
 * - beacon: all good. Complete, current, watched.
 * - tidepool: all good by rule, mid-rebuild: no good stats yet, so it draws the indexing line and the cyan chip.
 * - old-scripts: not indexed, the folder is gone. notes: not indexed.
 */
import type { CodegraphRepo, CodegraphResponse, CodegraphStats } from '../../../shared/types.js';

import { DAY, EPOCH, HOUR, MIN, SEC, ago } from './epoch.js';
import { HOME, PROJECTS } from './sessions.js';

const LUMEN = { name: 'lumen-cli', dirName: '-Users-dev-code-lumen-cli', path: `${HOME}/code/lumen-cli` };
const BEACON = { name: 'beacon', dirName: '-Users-dev-code-beacon', path: `${HOME}/code/beacon` };
const TIDEPOOL = { name: 'tidepool', dirName: '-Users-dev-code-tidepool', path: `${HOME}/code/tidepool` };
const OLD_SCRIPTS = { name: 'old-scripts', dirName: '-Users-dev-code-old-scripts', path: `${HOME}/code/old-scripts` };
const NOTES = { name: 'notes', dirName: '-Users-dev-notes', path: `${HOME}/notes` };

function stats(over: Partial<CodegraphStats>): CodegraphStats {
  return {
    lastIndexedMs: ago(2 * HOUR),
    fileCount: 416,
    nodeCount: 8254,
    edgeCount: 33969,
    dbSizeBytes: 36786176,
    nodesByKind: { class: 8, constant: 1145, file: 405, function: 2637, import: 1968, interface: 302, method: 65, property: 1481, type_alias: 134, variable: 109 },
    languages: ['javascript', 'tsx', 'typescript', 'yaml'],
    pending: { added: 0, modified: 0, removed: 0 },
    worktreeMismatch: null,
    version: '1.6.2',
    indexState: 'complete',
    reindexRecommended: false,
    builtWithVersion: '1.6.2',
    builtWithExtractionVersion: 27,
    currentExtractionVersion: 27,
    ...over
  };
}

const idle = { watching: false, watcherSinceMs: null, rebuildLive: false, run: null, lastRun: null } as const;

const repos: CodegraphRepo[] = [
  {
    dirName: PROJECTS.aurora.dirName,
    name: PROJECTS.aurora.name,
    path: PROJECTS.aurora.path,
    ...idle,
    state: 'ok',
    root: PROJECTS.aurora.path,
    stats: stats({
      fileCount: 1204,
      nodeCount: 21870,
      edgeCount: 90412,
      dbSizeBytes: 98566144,
      lastIndexedMs: ago(26 * HOUR),
      languages: ['go', 'sql', 'typescript'],
      pending: { added: 2, modified: 5, removed: 0 },
      worktreeMismatch: { worktreeRoot: `${PROJECTS.aurora.path}/.worktrees/orders-rate-limit`, indexRoot: PROJECTS.aurora.path }
    })
  },
  {
    dirName: PROJECTS.harbor.dirName,
    name: PROJECTS.harbor.name,
    path: PROJECTS.harbor.path,
    ...idle,
    lastRun: { kind: 'sync', ok: false, endedAtMs: ago(9 * MIN), message: 'could not read src/generated/schema.ts: permission denied' },
    state: 'ok',
    root: PROJECTS.harbor.path,
    stats: stats({ fileCount: 689, nodeCount: 12031, edgeCount: 48870, dbSizeBytes: 52428800, lastIndexedMs: ago(3 * DAY), indexState: 'partial' })
  },
  {
    dirName: LUMEN.dirName,
    name: LUMEN.name,
    path: LUMEN.path,
    ...idle,
    watching: true,
    watcherSinceMs: ago(5 * HOUR),
    state: 'ok',
    root: LUMEN.path,
    stats: stats({ fileCount: 187, nodeCount: 3342, edgeCount: 12904, dbSizeBytes: 5767168, languages: ['rust'], builtWithExtractionVersion: 26, reindexRecommended: true })
  },
  {
    dirName: BEACON.dirName,
    name: BEACON.name,
    path: BEACON.path,
    ...idle,
    watching: true,
    watcherSinceMs: ago(2 * DAY),
    state: 'ok',
    root: BEACON.path,
    stats: stats({ fileCount: 92, nodeCount: 1480, edgeCount: 5210, dbSizeBytes: 2097152, languages: ['python'], lastIndexedMs: ago(11 * MIN) })
  },
  {
    dirName: TIDEPOOL.dirName,
    name: TIDEPOOL.name,
    path: TIDEPOOL.path,
    ...idle,
    watching: false,
    rebuildLive: true,
    run: { kind: 'reindex', startedAtMs: EPOCH - 40 * SEC },
    state: 'building',
    root: TIDEPOOL.path
  },
  { dirName: OLD_SCRIPTS.dirName, name: OLD_SCRIPTS.name, path: null, ...idle, state: 'missing' },
  { dirName: NOTES.dirName, name: NOTES.name, path: NOTES.path, ...idle, state: 'none' }
];

export const codegraph: CodegraphResponse = { generatedAt: EPOCH, cli: 'ok', repos };
