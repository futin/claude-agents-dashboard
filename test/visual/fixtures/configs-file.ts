/** `GET /api/configs/file` — one skill body (`?path=` is ignored, so every opened file shows this one). */
import type { FileContent } from '../../../shared/types.js';

import { SKILL_PATH } from './configs.js';

const content = `---
name: release-notes
description: Draft release notes from the merged pull requests since the last tag.
---

# Release notes

1. Find the last tag with \`git describe --tags --abbrev=0\`.
2. List the merged pull requests since it.
3. Group them under **Features**, **Fixes** and **Chores**, one line each.

Keep each line under 100 characters and link the pull request number.
`;

export const configsFile: FileContent = {
  path: SKILL_PATH,
  content,
  size: content.length,
  truncated: false
};
