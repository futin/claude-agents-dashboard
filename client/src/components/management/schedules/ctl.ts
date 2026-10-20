import type { PinRow } from '../../../../../shared/types';

/**
 * What every Schedules component reads and calls, built once by `SchedulesView`. `owner` false hides every write control (another server, or none, owns
 * the schedules on this machine); `locked` keeps them drawn but disabled, for a read-only network or a missing Answer token.
 */
export interface ScheduleCtl {
  now: Date;
  machine: 'mac' | 'wsl';
  /** The schedules folder, `~` expanded. */
  dir: string;
  owner: boolean;
  locked: boolean;
  /** The key of the write in flight. */
  busy: string | null;
  days: 7 | 30 | 90;
  /** Under 640 px: the Run-now popover becomes a sheet and labels shorten. The row layouts swap in CSS, at 1024. */
  phone: boolean;
  pins: PinRow[];
  /** No `only` runs every repo; a list runs those pins. Never called with an empty list. */
  runNow(name: string, only?: string[]): void;
  stop(name: string): void;
  toggle(name: string, enabled: boolean): void;
  /** Opens the session's ChatDrawer; resolves to a one-line failure (transcript gone, fetch failed) for the link to show in place, null on success. */
  openSession(id: string): Promise<string | null>;
  edit(name: string, confirmDelete?: boolean): void;
  reveal(name: string): void;
  copyLabel(name: string): void;
  allRuns(name: string): void;
}
