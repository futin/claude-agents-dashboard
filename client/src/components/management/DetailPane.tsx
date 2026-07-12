import { FileViewer } from './FileViewer';
import { HookDetail } from './HookDetail';
import { MarkdownViewer } from './MarkdownViewer';
import type { Entry } from '../../lib/managementEntries';

interface Props {
  entry: Entry | null;
  /** Type context for the header chip, e.g. 'Skills' — singularized here. */
  groupTitle: string | null;
}

/** 'Skills' → 'skill' etc. for the little type chip. */
function typeLabel(title: string): string {
  const t = title.toLowerCase();
  return t.endsWith('s') ? t.slice(0, -1) : t;
}

/** Right pane: selected entry's metadata + its file content. */
export function DetailPane({ entry, groupTitle }: Props) {
  if (entry === null) {
    return <div className="mdetail"><div className="mgmt-empty">select an item to inspect it</div></div>;
  }

  if (entry.kind === 'hook') {
    return (
      <div className="mdetail">
        {groupTitle !== null ? <div className="mdetail-type">{typeLabel(groupTitle)}</div> : null}
        <HookDetail hook={entry.hook} />
      </div>
    );
  }

  return (
    <div className="mdetail">
      {groupTitle !== null ? <div className="mdetail-type">{typeLabel(groupTitle)}</div> : null}
      <div className="mdetail-head">
        <span className="mitem-name">{entry.label}</span>
        <span className={entry.badge.startsWith('plugin:') ? 'msrc plugin' : 'msrc'}>{entry.badge}</span>
      </div>
      {entry.sublabel !== null ? <div className="mitem-desc">{entry.sublabel}</div> : null}
      {entry.filePath !== null ? (
        <>
          <div className="mdetail-path">{entry.filePath}</div>
          {entry.fileKind === 'markdown'
            ? <MarkdownViewer path={entry.filePath} />
            : <FileViewer path={entry.filePath} pretty={entry.fileKind === 'json'} />}
        </>
      ) : (
        <div className="mgmt-empty">no file to show for this item</div>
      )}
    </div>
  );
}
