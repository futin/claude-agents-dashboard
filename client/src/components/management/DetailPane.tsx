import { useState } from 'react';

import { FileBlock } from './FileBlock';
import { HookDetail } from './HookDetail';
import { SkillFileRail } from './SkillFileRail';
import type { Entry, EntryFile } from '../../lib/managementEntries';

interface Props {
  /**
   * Never null: column 3 is drawn only when something is selected (DESIGN.md
   * §8.5) — an empty inspector holding a "select an item" line is a third of
   * the page spent saying nothing.
   */
  entry: Entry;
  /** Type context for the header chip, e.g. 'Skills' — singularized here. */
  groupTitle: string | null;
}

/** 'Skills' → 'skill' etc. for the little type chip. */
function typeLabel(title: string): string {
  const t = title.toLowerCase();
  return t.endsWith('s') ? t.slice(0, -1) : t;
}

/** Column 3: selected entry's metadata + its file content. */
export function DetailPane({ entry, groupTitle }: Props) {
  /** Which file of a multi-file skill the viewer shows; tagged with its entry. */
  const [picked, setPicked] = useState<{ entryKey: string; path: string } | null>(null);

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
        // `key` on the path: switching entries has to reset the fold and the
        // Code/Preview pick, not carry one file's reading state onto the next.
        <>
          <div className="mdetail-label rule">file</div>
          <FileBlock key={shownPath} path={shownPath} kind={shownKind} />
        </>
      ) : (
        <div className="skill-body">
          {/* The rail is the skill's own table of contents, so it runs the full
              width ABOVE the file it picks rather than taking a column beside
              it: at 420px of pane a 190px side rail left the file a gutter. */}
          <div className="mdetail-label rule">files · {files.length}</div>
          <SkillFileRail
            files={files}
            selected={shownPath}
            onSelect={(f: EntryFile) => setPicked({ entryKey: entry.key, path: f.path })}
          />
          <FileBlock key={shownPath} path={shownPath} kind={shownKind} />
        </div>
      )}
    </div>
  );
}
