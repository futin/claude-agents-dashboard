import type { SessionSpend } from '../../../shared/types.js';

/** A compacted session with subagents, so the drawer card draws its longest form: the `≥` prefix and the split line. */
export const sessionSpend: SessionSpend = {
  id: 'fixture',
  main: 1_220_000,
  subagents: 3_390_000,
  total: 4_610_000,
  compactions: 1,
  uncountedSubagents: 0
};
