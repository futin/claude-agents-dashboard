import { FileViewer } from './FileViewer';
import type { Entry } from '../../lib/managementEntries';

interface Props {
  entry: Entry | null;
}

/** Right pane: selected entry's metadata + its file content. */
export function DetailPane({ entry }: Props) {
  if (entry === null) {
    return <div className="mdetail"><div className="mgmt-empty">select an item to inspect it</div></div>;
  }
  return (
    <div className="mdetail">
      <div className="mdetail-head">
        <span className="mitem-name">{entry.label}</span>
        <span className={entry.badge.startsWith('plugin:') ? 'msrc plugin' : 'msrc'}>{entry.badge}</span>
      </div>
      {entry.sublabel !== null ? <div className="mitem-desc">{entry.sublabel}</div> : null}
      {entry.filePath !== null ? (
        <>
          <div className="mdetail-path">{entry.filePath}</div>
          <FileViewer path={entry.filePath} />
        </>
      ) : (
        <div className="mgmt-empty">no file to show for this item</div>
      )}
    </div>
  );
}
