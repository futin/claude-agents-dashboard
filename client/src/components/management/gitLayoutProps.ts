import type { FetchClock, RepoGitStats, Session } from '../../../../shared/types';
import type { GitFetchControl } from '../../hooks/useGitFetch';
import type { GitSyncControl } from '../../hooks/useGitSync';
import type { GitLayout } from '../../lib/gitLayouts';

/** What GitView hands whichever of the four layouts is drawn, so each one reads the same inputs and none fetches for itself. */
export interface GitLayoutProps {
  repos: RepoGitStats[];            // pin order
  sessions: Session[];              // the live sessions payload, [] before it answers
  nowMs: number;                    // Date.now() at render
  clock: FetchClock | undefined;
  sync: GitSyncControl;
  fetchCtl: GitFetchControl;
  unpin: { busy: string | null; run: (dirName: string) => void };
  openFolder: (path: string) => void;
  narrow: boolean;
  setLayout: (l: GitLayout) => void;
}
