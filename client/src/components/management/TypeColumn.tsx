import type { EntryGroup } from '../../lib/managementEntries';

interface Props {
  /** Already filtered and stripped of empty types — only kinds with entries appear. */
  groups: EntryGroup[];
  selected: string | null;
  onSelect: (title: string) => void;
}

/**
 * Column 1 — one row per kind, its count as a pill on the right. The picked row
 * wears the same "you are here" mark as the item column: a `--strip-hi` fill
 * bled to the card's edge with a full-height ink bar against it, drawn as a
 * pseudo-element (an inset shadow gets clipped into a crescent by the row's
 * radius). Only the pane's padding — and so the bleed distance — differs.
 */
export function TypeColumn({ groups, selected, onSelect }: Props) {
  return (
    <div className="mgmt-pane">
      <div className="mgmt-kick">Type</div>
      {groups.length === 0 ? (
        <div className="mgmt-empty">no matches</div>
      ) : (
        groups.map(g => (
          <button
            key={g.title}
            className={g.title === selected ? 'mgmt-type on' : 'mgmt-type'}
            aria-current={g.title === selected ? 'true' : undefined}
            onClick={() => onSelect(g.title)}
          >
            <span className="n">{g.title}</span>
            <span className="c">{g.entries.length}</span>
          </button>
        ))
      )}
    </div>
  );
}
