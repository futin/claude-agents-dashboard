/**
 * apiError.ts — the row's badge text for a session stopped by an API error, kept here so it is testable without a DOM (the same split `stopControl.ts` uses).
 */

import type { ApiErrorState } from '../../../shared/types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A reset a day or more away names its weekday: a clock time alone would read as today. A reset already past says nothing, since the limit has lifted. */
function resetsText(resetsAtMs: number | null, nowMs: number): string {
  if (resetsAtMs === null || resetsAtMs <= nowMs) return '';
  const at = new Date(resetsAtMs);
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return ` · resets ${resetsAtMs - nowMs >= DAY_MS ? `${at.toLocaleDateString('en-GB', { weekday: 'short' })} ` : ''}${time}`;
}

export function apiErrorLabel(err: Pick<ApiErrorState, 'kind' | 'resetsAtMs'>, nowMs: number): string {
  switch (err.kind) {
    case 'rate_limit': return `usage limit${resetsText(err.resetsAtMs, nowMs)}`;
    case 'authentication_failed': return 'not logged in';
    case 'server_error': return 'API error';
    default: return `API error · ${err.kind}`;
  }
}
