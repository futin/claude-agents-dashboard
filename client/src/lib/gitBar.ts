import type { GitBranch } from '../../../shared/types';
import { gitBranchCounts } from './gitStatsText';

/**
 * Geometry of the GitHub-style divergence bar (behind ◂ | ▸ ahead). One scale per repo, shared by both sides: the largest count among the repo's listed
 * branches fills its half, everything else is proportional to it. Scaled over every listed branch, not only the visible five, so "+N more" never rescales
 * the rows already on screen.
 */
export const GIT_BAR_HALF_PX = 44;
/** A non-zero count never draws thinner than this, or 1 commit against 88 would vanish. */
export const GIT_BAR_MIN_PX = 2;

/** The largest ahead or behind among the branches that carry counts; 0 when none do. */
export function gitBarMax(branches: GitBranch[]): number {
  let max = 0;
  for (const b of branches) {
    const c = gitBranchCounts(b);
    if (c) max = Math.max(max, c.ahead, c.behind);
  }
  return max;
}

/** One side's width in px: 0 for a zero count, else proportional to `max` and at least `GIT_BAR_MIN_PX`. */
export function gitBarWidth(n: number, max: number, half: number = GIT_BAR_HALF_PX): number {
  if (n <= 0 || max <= 0) return 0;
  return Math.max(GIT_BAR_MIN_PX, Math.round((Math.min(n, max) / max) * half));
}
