/**
 * surface.ts — what a row says about where a session lives.
 *
 * Pure, and shared by the two places a session is titled: the list row
 * (`SessionRow`) and the chat drawer's header (`ChatDrawer`). One definition
 * because the *tooltip* is the actual content here — it's the sentence that
 * answers "why is this session not in my desktop app?" — and two copies of a
 * sentence that long drift.
 */

import type { SessionSurface } from '../../../shared/types';

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
 */
export function surfacePill(surface: SessionSurface): SurfacePill | null {
  if (surface === 'dashboard') {
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
