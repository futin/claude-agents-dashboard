/** `GET /api/pins` — both fixture projects pinned, one older project offered for pinning. */
import type { PinsResponse, ProjectRef } from '../../../shared/types.js';

import { DAY, MIN, SEC, ago } from './epoch.js';
import { HOME, PROJECTS } from './sessions.js';

/** The two fixture projects as the Configs rail and the pin picker list them, newest first. */
export const projectRefs: ProjectRef[] = [
  { dirName: PROJECTS.aurora.dirName, name: PROJECTS.aurora.name, path: PROJECTS.aurora.path, lastActiveMs: ago(4 * SEC), pinned: true },
  { dirName: PROJECTS.harbor.dirName, name: PROJECTS.harbor.name, path: PROJECTS.harbor.path, lastActiveMs: ago(45 * SEC), pinned: true }
];

export const pins: PinsResponse = {
  pinned: projectRefs.map(p => ({ dirName: p.dirName, name: p.name, path: p.path, lastActiveMs: p.lastActiveMs, listed: true })),
  recent: [],
  older: [{ dirName: '-Users-dev-code-atlas-docs', name: 'atlas-docs', path: `${HOME}/code/atlas-docs`, lastActiveMs: ago(9 * DAY + 40 * MIN) }],
  home: HOME
};
