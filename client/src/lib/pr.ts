import type { PrChecks, SessionPr, SessionPrInfo, SessionPrLive, SessionPrResponse } from '../../../shared/types';

/** The PR card's four tones; each maps to a `.pr-*` modifier class of the same name. Copy below is spec §Copy, verbatim. */
export type PrTone = 'ok' | 'bad' | 'dim' | 'run';

export interface PrRow {
  text: string;
  tone: PrTone;
}

/** The desktop Checks row: first matching rule wins. */
export function checksRow(c: PrChecks | null): PrRow {
  if (!c) return { text: 'None', tone: 'dim' };
  if (c.failed > 0) {
    const running = c.running > 0 ? ` · ${c.running} running` : '';
    return { text: `${c.failed} failed · ${c.passed} passed${running}`, tone: 'bad' };
  }
  if (c.running > 0) return { text: `${c.passed} of ${c.total} passed · ${c.running} running`, tone: 'run' };
  return { text: `${c.total} of ${c.total} passed`, tone: 'ok' };
}

/** One segment per counted check for the bar: failed, then running, then passed. */
export function checkSegments(c: PrChecks | null): PrTone[] {
  if (!c) return [];
  return [
    ...Array<PrTone>(c.failed).fill('bad'),
    ...Array<PrTone>(c.running).fill('run'),
    ...Array<PrTone>(c.passed).fill('ok'),
  ];
}

const REVIEW: Record<SessionPrLive['review'], PrRow> = {
  approved: { text: 'Approved', tone: 'ok' },
  changes: { text: 'Changes requested', tone: 'bad' },
  required: { text: 'Required', tone: 'dim' },
  none: { text: 'Not requested', tone: 'dim' },
};

export function reviewRow(r: SessionPrLive['review']): PrRow {
  return REVIEW[r];
}

export function mergeRow(m: SessionPrLive['merge'], base: string): PrRow {
  if (m === 'clean') return { text: 'No conflicts', tone: 'ok' };
  if (m === 'conflicts') return { text: `Conflicts with ${base}`, tone: 'bad' };
  return { text: 'Checking…', tone: 'dim' };
}

const STATE: Record<SessionPrLive['state'], string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };

export function stateLabel(s: SessionPrLive['state']): string {
  return STATE[s];
}

/** The line under an ended PR's title: where it went and how long ago. For merged or closed PRs only. */
export function endedLine(live: SessionPrLive, ago: (iso: string) => string): string {
  const head = live.state === 'merged' ? `into ${live.base}` : 'not merged';
  return live.endedAt ? `${head} · ${ago(live.endedAt)}` : head;
}

const REVIEW_SHORT: Record<SessionPrLive['review'], string> = {
  approved: 'approved', changes: 'changes requested', required: 'review required', none: 'no review',
};

/** The folded phone band's `<line>`, by state. */
export function bandLine(pr: SessionPrInfo, ago: (iso: string) => string): string {
  const live = pr.live;
  if (!live) return 'status unavailable';
  if (live.state === 'merged' || live.state === 'closed') return endedLine(live, ago);
  const c = live.checks;
  const checks = !c ? 'no checks' : c.failed > 0 ? `${c.failed} failed` : `${c.passed}/${c.total} checks`;
  return `${checks} · ${REVIEW_SHORT[live.review]}`;
}

/** The hook's whole update rule: an answer for another session or an error keeps what is shown; anything else replaces it. */
export function acceptPrAnswer(currentId: string, body: SessionPrResponse, prev: SessionPr): SessionPr {
  if (body.id !== currentId || body.error) return prev;
  return body.pr;
}
