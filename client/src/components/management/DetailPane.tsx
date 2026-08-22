import { useState } from 'react';

import { FileViewer } from './FileViewer';
import { HookDetail } from './HookDetail';
import { MarkdownViewer } from './MarkdownViewer';
import { SkillFileRail } from './SkillFileRail';
import type { Entry, EntryFile, FileKind } from '../../lib/managementEntries';

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

function viewerFor(path: string, kind: FileKind) {
  return kind === 'markdown'
    ? <MarkdownViewer path={path} />
    : <FileViewer path={path} pretty={kind === 'json'} />;
}

/** Right pane: selected entry's metadata + its file content. */
export function DetailPane({ entry, groupTitle }: Props) {
  /** Which file of a multi-file skill the viewer shows; tagged with its entry. */
  const [picked, setPicked] = useState<{ entryKey: string; path: string } | null>(null);

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

  const files = entry.files;
  // Resolve during render (the pattern the rest of Management uses): a pick made
  // on another entry — or on a file a refresh dropped — falls back to SKILL.md.
  const active =
    files !== undefined && picked !== null && picked.entryKey === entry.key
      ? files.find(f => f.path === picked.path) ?? null
      : null;
  const shownPath = active?.path ?? entry.filePath;
  const shownKind = active?.fileKind ?? entry.fileKind;

  return (
    <div className="mdetail">
      {groupTitle !== null ? <div className="mdetail-type">{typeLabel(groupTitle)}</div> : null}
      <div className="mdetail-head">
        <span className="mitem-name">{entry.label}</span>
        <span className={entry.badge.startsWith('plugin:') ? 'msrc plugin' : 'msrc'}>{entry.badge}</span>
      </div>
      {entry.sublabel !== null ? <div className="mitem-desc">{entry.sublabel}</div> : null}
      {shownPath === null ? (
        <div className="mgmt-empty">no file to show for this item</div>
      ) : files === undefined ? (
        <>
          <div className="mdetail-path">{shownPath}</div>
          {viewerFor(shownPath, shownKind)}
        </>
      ) : (
        <div className="skill-body">
          <SkillFileRail
            files={files}
            selected={shownPath}
            onSelect={(f: EntryFile) => setPicked({ entryKey: entry.key, path: f.path })}
          />
          <div className="skill-file">
            <div className="mdetail-path">{shownPath}</div>
            {viewerFor(shownPath, shownKind)}
          </div>
        </div>
      )}
    </div>
  );
}
