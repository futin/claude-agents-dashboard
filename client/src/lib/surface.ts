/**
 * surface.ts — what a row says about where a session lives.
 *
 * Pure, and shared by the two places a session is titled: the list row
 * (`sessions/atoms.tsx`) and the chat drawer's header (`ChatDrawer`). One definition
 * because the *tooltip* is the actual content here — it's the sentence that
 * answers "why is this session not in my desktop app?" — and two copies of a
 * sentence that long drift.
 */

import { DESKTOP_HANDOVER_FAILED_TEXT } from './launchSurface';
import type { Session } from '../../../shared/types';

export interface SurfacePill {
  /** Pill text. Lower case; `.ag-pill` upper-cases it in CSS. */
  label: string;
  /** `title` attribute: what the pill means, and where you can continue the session. */
  title: string;
}

/**
 * The pill for a surface, or `null` for one that needs no comment.
 *
 * `local` returns null on purpose: an ordinary terminal or desktop-app session
 * is the overwhelming majority of rows, and a pill on every one of them would
 * compete with the fields already printed in `.r1` while telling you nothing
 * you didn't assume. Only a surface that breaks the assumption gets to speak.
 *
 * A `desktopOwned` row is silent too. It was imported into the desktop app but not yet continued there, so its transcript still reads `dashboard`
 * and the row keeps that surface, which the drawer's hand-over needs to say `owned`. The pill's claim, that no other list has the session, stopped
 * being true at the import. Takes the session rather than its surface so no render site can forget the flag.
 *
 * A `handOverFailed` row swaps the label: the launch form promised a move that did not happen, and the form has closed by now, so the row has to say so.
 */
export function surfacePill(session: Pick<Session, 'surface' | 'desktopOwned' | 'handOverFailed'>): SurfacePill | null {
  const { surface } = session;
  if (surface === 'dashboard') {
    if (session.desktopOwned) return null;
    if (session.handOverFailed) {
      return {
        label: 'hand-over failed',
        title: `${DESKTOP_HANDOVER_FAILED_TEXT} Retry with Open in desktop app in the chat drawer.`
      };
    }
    return {
      label: 'dashboard',
      title: 'Headless spawn — this dashboard is the only list it appears in. '
        + 'Continue it here with the reply window, or run `claude --resume <id>` in a terminal.'
    };
  }
  if (surface === 'cloud') {
    return {
      label: 'cloud',
      title: 'Runs in Anthropic’s sandbox, not on this machine — no local skills, memory, or files.'
    };
  }
  return null;
}
