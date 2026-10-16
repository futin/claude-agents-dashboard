/**
 * `GET /api/releases` — two commits past `v0.3.0`, so every rail draws the chip as `v0.3.0+2`. One entry per thing the drawer draws differently: notes as
 * markdown with a PR link, a fix with empty notes (no notes block, PR link only), a breaking release without a PR url, and the baseline divider.
 */
import type { ReleasesResponse } from '../../../shared/types.js';

import { agoIso, DAY } from './epoch.js';

const PR = 'https://github.com/futin/claude-agents-dashboard/pull/';

export const releases: ReleasesResponse = {
  current: { version: '0.3.0', ahead: 2 },
  releases: [
    {
      version: '0.3.0',
      date: agoIso(1 * DAY),
      title: "feat(releases): version chip and What's new drawer",
      type: 'feat',
      scope: 'releases',
      pr: 216,
      breaking: false,
      notes: '- The rail shows the running version.\n- **Every** release, newest first.',
      url: PR + '216'
    },
    {
      version: '0.2.1',
      date: agoIso(4 * DAY),
      title: 'fix(sessions): keep the open window across a reload',
      type: 'fix',
      scope: 'sessions',
      pr: 214,
      breaking: false,
      notes: '',
      url: PR + '214'
    },
    {
      version: '0.2.0',
      date: agoIso(9 * DAY),
      title: 'feat(settings)!: one settings key per browser',
      type: 'feat',
      scope: 'settings',
      breaking: true,
      notes: 'Settings saved by an older build are read once and rewritten under the new key.'
    },
    {
      version: '0.1.0',
      date: agoIso(14 * DAY),
      title: 'Baseline — versioning starts here',
      type: 'baseline',
      breaking: false,
      notes: ''
    }
  ]
};
