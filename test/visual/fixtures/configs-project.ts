/** `GET /api/configs/project` — one project scope (`?dir=` is ignored, so every project shows aurora-api's config). */
import type { ScopeConfig } from '../../../shared/types.js';

import { PROJECTS } from './sessions.js';

const ROOT = PROJECTS.aurora.path;

export const configsProject: ScopeConfig = {
  scope: 'project',
  root: ROOT,
  skills: [{ name: 'seed-db', description: 'Load the local development fixtures.', path: `${ROOT}/.claude/skills/seed-db/SKILL.md`, source: 'project' }],
  agents: [],
  commands: [{ name: 'deploy-preview', description: 'Deploy the branch to a preview stack.', path: `${ROOT}/.claude/commands/deploy-preview.md`, source: 'project' }],
  rules: [],
  hooks: [
    {
      event: 'PostToolUse',
      matcher: 'Edit|Write',
      command: 'pnpm lint --fix',
      source: 'project',
      declaredIn: `${ROOT}/.claude/settings.json`,
      scriptPath: null
    }
  ],
  memory: [
    { name: 'CLAUDE.md', description: null, path: `${ROOT}/CLAUDE.md`, source: 'project' },
    { name: 'CLAUDE.md', description: null, path: `${ROOT}/.claude/CLAUDE.md`, source: 'project' }
  ],
  settings: [
    { label: 'settings.json', path: `${ROOT}/.claude/settings.json`, exists: true },
    { label: 'settings.local.json', path: `${ROOT}/.claude/settings.local.json`, exists: true }
  ],
  plugins: [],
  mcpServers: [
    {
      name: 'postgres',
      source: 'project',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'example-postgres-mcp'],
      url: null,
      envKeys: ['DATABASE_URL'],
      headerKeys: [],
      declaredIn: `${ROOT}/.mcp.json`,
      disabled: false
    }
  ]
};
