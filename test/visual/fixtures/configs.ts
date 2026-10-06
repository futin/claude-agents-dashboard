/** `GET /api/configs` — the global scope (skills, agents, hooks, a plugin, MCP servers) and the two fixture projects for the rail. */
import type { ConfigItem, ManagementIndex } from '../../../shared/types.js';

import { agoIso } from './epoch.js';
import { projectRefs } from './pins.js';
import { HOME } from './sessions.js';

const ROOT = `${HOME}/.claude`;
const PLUGIN = `${ROOT}/plugins/cache/example-tools/devkit/1.4.0`;

function item(dir: string, name: string, description: string | null, source = 'user'): ConfigItem {
  return { name, description, path: `${dir}/${name}.md`, source };
}

/** The skill whose SKILL.md `/api/configs/file` serves. */
export const SKILL_PATH = `${ROOT}/skills/release-notes/SKILL.md`;

export const configs: ManagementIndex = {
  generatedAt: agoIso(0),
  global: {
    scope: 'global',
    root: ROOT,
    skills: [
      {
        name: 'release-notes',
        description: 'Draft release notes from the merged pull requests since the last tag.',
        path: SKILL_PATH,
        source: 'user',
        files: [{ rel: 'SKILL.md', size: 2_140 }, { rel: 'references/style.md', size: 860 }]
      },
      { name: 'db-migrate', description: 'Plan and check a schema migration before it runs.', path: `${ROOT}/skills/db-migrate/SKILL.md`, source: 'user' },
      { name: 'lint-fix', description: 'Run the linters and fix what they report.', path: `${PLUGIN}/skills/lint-fix/SKILL.md`, source: 'plugin:devkit' }
    ],
    agents: [
      item(`${ROOT}/agents`, 'code-reviewer', 'Reviews a diff for correctness, then style.'),
      item(`${PLUGIN}/agents`, 'test-writer', 'Writes focused unit tests for one module.', 'plugin:devkit')
    ],
    commands: [item(`${ROOT}/commands`, 'standup', 'Summarise yesterday’s commits for a standup.')],
    rules: [item(`${ROOT}/rules`, 'typescript', 'House TypeScript conventions.')],
    hooks: [
      { event: 'PreToolUse', matcher: 'Bash', command: `${ROOT}/hooks/guard-rm.sh`, source: 'user', declaredIn: `${ROOT}/settings.json`, scriptPath: `${ROOT}/hooks/guard-rm.sh` },
      { event: 'Stop', matcher: null, command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/notify.js', source: 'plugin:devkit', declaredIn: `${PLUGIN}/hooks/hooks.json`, scriptPath: null }
    ],
    memory: [{ name: 'CLAUDE.md', description: null, path: `${ROOT}/CLAUDE.md`, source: 'user' }],
    settings: [
      { label: 'settings.json', path: `${ROOT}/settings.json`, exists: true },
      { label: 'settings.local.json', path: `${ROOT}/settings.local.json`, exists: false }
    ],
    plugins: [
      {
        key: 'devkit@example-tools',
        name: 'devkit',
        marketplace: 'example-tools',
        version: '1.4.0',
        description: 'Everyday lint, test and notify helpers.',
        installPath: PLUGIN,
        enabled: true,
        manifestPath: `${PLUGIN}/.claude-plugin/plugin.json`,
        counts: { skills: 1, agents: 1, commands: 0, rules: 0, hooks: 1 }
      }
    ],
    mcpServers: [
      {
        name: 'issues',
        source: 'user',
        transport: 'http',
        command: null,
        args: [],
        url: 'https://mcp.example.com/issues',
        envKeys: [],
        headerKeys: ['Authorization'],
        declaredIn: `${HOME}/.claude.json`,
        disabled: false
      },
      {
        name: 'sqlite',
        source: 'user',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'example-sqlite-mcp'],
        url: null,
        envKeys: ['DB_PATH'],
        headerKeys: [],
        declaredIn: `${HOME}/.claude.json`,
        disabled: true
      }
    ]
  },
  projects: projectRefs
};
