import type { LaunchingSession, Session } from '../../../../shared/types';

/** What every view is handed: the filtered, sorted list and the open set. */
export interface ViewProps {
  sessions: Session[];
  /** Phantom launches, already reduced to the ones worth a row (see SessionsView). */
  launching: LaunchingSession[];
  /** Sessions drawn open — the expanded body under the card, row or tile. */
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onOpenChat: (id: string) => void;
}
