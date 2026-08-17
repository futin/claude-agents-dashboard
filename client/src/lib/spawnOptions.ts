/**
 * spawnOptions.ts — the option lists `SpawnPanel`'s model/effort/permission-mode
 * selects render, plus the pure logic for which permission modes the host
 * will actually honor.
 *
 * `MODELS` / `EFFORTS` / `PERMISSION_MODES` mirror `server/lib/spawn.ts`'s
 * own exports of the same names, verbatim. Duplicated rather than imported:
 * that module is server-only — the FE/BE boundary is `shared/types.ts`
 * alone, and `SpawnRequest.model` / `.effort` are deliberately typed as plain
 * `string`, not a literal union, precisely so the server can accept or drop a
 * value independently of what any given client build knows about. Because
 * this is a plain duplication rather than a derived/generated copy, drift is
 * only caught by a test: `test/spawn-options.test.ts` asserts all three stay
 * byte-for-byte equal to the server's arrays, so a change on one side that
 * forgets the other fails a test instead of silently degrading the picker.
 */
import type { PermissionMode } from '../../../shared/types';

/** Mirrors server/lib/spawn.ts's MODELS. */
export const MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;

/** Mirrors server/lib/spawn.ts's EFFORTS. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Mirrors server/lib/spawn.ts's PERMISSION_MODES — lowest to highest on the
 * ladder. Array index order IS the ordering (the server's own comment states
 * the same invariant for its copy), which is what makes
 * `allowedPermissionModes` below a plain slice.
 */
export const PERMISSION_MODES: readonly PermissionMode[] = ['plan', 'acceptEdits', 'auto', 'bypassPermissions'];

/** Display copy for a permission mode — the values themselves are camelCase identifiers, not copy. */
export const PERMISSION_MODE_LABEL: Record<PermissionMode, string> = {
  plan: 'plan',
  acceptEdits: 'accept edits',
  auto: 'auto',
  bypassPermissions: 'bypass permissions'
};

/** Mirrors server/lib/spawn.ts's NAME_CAP. */
export const NAME_CAP = 60;

/** Mirrors server/lib/spawn.ts's PROMPT_CAP. */
export const PROMPT_CAP = 4000;

/**
 * The permission modes the launch picker may offer: every mode at or below
 * `ceiling` on the ladder. Mirrors the server's own `clampPermission` /
 * `modeIndex` fallback exactly — an unrecognized or absent ceiling resolves
 * to `'auto'`, never to the top of the ladder, so a picker that doesn't yet
 * know the server's ceiling (the health poll hasn't answered yet, or an
 * older server that predates `HealthResponse.spawnMaxPermission`) fails
 * toward the safe default instead of toward offering a mode the server will
 * silently refuse to honor.
 *
 * The result is never empty and always ends on the (validated) ceiling
 * itself — callers needing "what should be pre-selected" can just take the
 * last element, or `'auto'` when it's in the list.
 */
export function allowedPermissionModes(ceiling: PermissionMode | undefined): PermissionMode[] {
  const requestedIdx = ceiling ? PERMISSION_MODES.indexOf(ceiling) : -1;
  const idx = requestedIdx === -1 ? PERMISSION_MODES.indexOf('auto') : requestedIdx;
  return PERMISSION_MODES.slice(0, idx + 1);
}
