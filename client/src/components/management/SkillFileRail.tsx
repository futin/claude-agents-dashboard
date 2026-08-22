import { railRows, type EntryFile } from '../../lib/managementEntries';
import { fmtBytes } from '../../lib/format';

interface Props {
  files: EntryFile[];
  /** Absolute path of the file currently shown in the viewer. */
  selected: string;
  onSelect: (file: EntryFile) => void;
}

/**
 * The skill directory as a file rail beside the viewer: root files first, then
 * one header per folder. Every path here was enumerated by the scanner, so each
 * is servable — clicking one just swaps which of them the viewer fetches.
 */
export function SkillFileRail({ files, selected, onSelect }: Props) {
  return (
    <div className="frail">
      <div className="frail-h">files · {files.length}</div>
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
