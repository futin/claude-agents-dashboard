import { railRows, type EntryFile } from '../../lib/managementEntries';
import { fmtBytes } from '../../lib/format';

interface Props {
  files: EntryFile[];
  /** Absolute path of the file currently shown in the viewer. */
  selected: string;
  onSelect: (file: EntryFile) => void;
}

/**
 * The skill directory as a strip of file chips ABOVE the viewer: root files
 * first, then one label per folder. Every path here was enumerated by the
 * scanner, so each is servable — clicking one just swaps which of them the
 * viewer fetches. The count lives in the `files · N` kicker the pane draws
 * over this, so the strip carries no header of its own.
 */
export function SkillFileRail({ files, selected, onSelect }: Props) {
  return (
    <div className="frail">
      {railRows(files).map(row =>
        row.kind === 'dir' ? (
          <div className="fdir" key={`dir:${row.dir}`}>{row.dir}</div>
        ) : (
          <button
            type="button"
            key={row.file.path}
            className={
              (row.file.path === selected ? 'ffile on' : 'ffile') + (row.nested ? ' ind' : '')
            }
            onClick={() => onSelect(row.file)}
          >
            <span className="ffile-name">{row.label}</span>
            <span className="fsize">{fmtBytes(row.file.size)}</span>
          </button>
        )
      )}
    </div>
  );
}
