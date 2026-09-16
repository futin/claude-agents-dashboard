/**
 * How a subagent's `subagent_type` is rendered.
 *
 * The controller dispatches almost everything as `general-purpose`, so that
 * label is a constant column: identical on every row, carrying no signal, while
 * eating width from the field that does (the description). The rule here is to
 * render the type only when it is informative — `Explore`, `Plan`,
 * `claude-code-guide`, a project agent — and nothing when it is the documented
 * catch-all or the record omitted it altogether (bug-24).
 */

/** The catch-all `subagent_type` the Task tool falls back to. */
export const DEFAULT_SUBAGENT_TYPE = 'general-purpose';

/**
 * The type label for a session-detail agent row, or `null` when the row should
 * show none. The row has its own description column, so a hidden label costs
 * the reader nothing and returns its width to the description.
 */
export function agentTypeLabel(type: string | undefined | null): string | null {
  const t = (type ?? '').trim();
  if (!t) return null;
  if (t.toLowerCase() === DEFAULT_SUBAGENT_TYPE) return null;
  return t;
}

/**
 * The name for an Analytics "Top subagents" line. That surface has no separate
 * description column — the type *is* the row's name — so hiding it would leave
 * the line nameless. It falls back to the description instead, which is the
 * per-agent signal, and to a generic marker only when neither is present.
 */
export function agentLineName(
  type: string | undefined | null,
  description: string | undefined | null
): string {
  const label = agentTypeLabel(type);
  if (label) return label;
  const desc = (description ?? '').trim();
  return desc || 'agent';
}
