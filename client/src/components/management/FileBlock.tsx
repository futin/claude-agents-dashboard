import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';

import { parseFrontmatter } from '../../../../shared/frontmatter';
import { useFileContent } from '../../hooks/useManagement';
import { fmtTok } from '../../lib/format';
import { Markdown } from '../Markdown';
import type { FileKind } from '../../lib/managementEntries';

interface Props {
  path: string;
  kind: FileKind;
}

/**
 * Frontmatter keys the card has already shown by the time the block is drawn:
 * `name` is the entry's title and `description` its summary, both printed in
 * `.mdetail-head` above. Listing them again under the path made the pane open
 * by saying the same two things twice.
 */
const HEADER_KEYS = new Set(['name', 'description']);

function baseName(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? path : path.slice(cut + 1);
}

function prettyJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

/**
 * One file as a foldable block, the same shape PlanPanel's `.qp-planblock`
 * gives a proposed plan: a kicker, the file's own name as the title, a
 * `read all` fold, and the opening lines clipped under a fade — the whole
 * clipped box being the control that opens it.
 *
 * Expanded it takes NO max-height of its own: the document body is the page's
 * single scroller (DESIGN §8.5), so a long file is read by scrolling the page
 * rather than a pane pinned inside it.
 *
 * A markdown file also gets a Code / Preview switch, and whatever its YAML
 * frontmatter holds beyond `name` and `description` comes out above the block
 * as plain label + value lines — machine-oriented metadata, but not a reason
 * for a second surface inside the card.
 */
export function FileBlock({ path, kind }: Props) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(kind === 'markdown');
  const boxId = useId();
  const { file, loading, error } = useFileContent(path);

  // Every block is preceded by the path of the file it shows, so the path line
  // lives here rather than being repeated at each call site. It is a label plus
  // plain wrapping text — a filled block around an absolute path was a surface
  // spent on the one string nobody reads twice.
  const frame = (body: ReactNode) => (
    <>
      <div className="mdetail-path">
        <span className="mdetail-pathlab">Path:</span>
        <span className="mdetail-pathval">{path}</span>
      </div>
      {body}
    </>
  );
  const shell = (body: ReactNode) => frame(
    <div className="mfileblock">
      <div className="mfilehead">
        <span className="mfile-title" title={path}>{baseName(path)}</span>
      </div>
      {body}
    </div>
  );

  if (loading) return shell(<div className="mgmt-empty">loading…</div>);
  if (error) return shell(<div className="mgmt-empty off">couldn't load this file</div>);
  if (file === null) return frame(null);

  // Frontmatter is only split off a markdown file; every other kind is its own
  // body, byte for byte (pretty-printed JSON excepted, and never when truncated
  // — half a document does not parse).
  const fm = kind === 'markdown' ? parseFrontmatter(file.content) : null;
  // Two different questions, so two different lists: `fmKeys` answers "was
  // there a frontmatter block to strip off the body", `metaKeys` answers "is
  // any of it worth printing". Collapsing them would make a skill whose
  // frontmatter is only name + description re-print that block as body text.
  const fmKeys = fm === null ? [] : Object.keys(fm.data);
  const metaKeys = fmKeys.filter(k => !HEADER_KEYS.has(k.toLowerCase()));
  const text =
    fm !== null
      ? (fmKeys.length > 0 ? fm.body : file.content)
      : kind === 'json' && !file.truncated
        ? prettyJson(file.content)
        : file.content;
  const shown = text === '' ? '(empty file)' : text;
  const canPreview = kind === 'markdown';
  const rendered = canPreview && preview;
  // An estimate, not a measurement (this page resolves everything during render
  // and keeps effects out of it): ~64 columns at the pane's width against the
  // 200px clip. A file that already fits gets no fold and no fade — a gradient
  // over the last three lines of a short file is the UI lying about there being
  // more to read.
  const rows = shown.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 64)), 0);
  const foldable = rows > 12;
  const expanded = open || !foldable;

  const toggle = (e: SyntheticEvent) => {
    // A rendered file carries links, and a reader mid-drag-select is not asking
    // to fold the thing they are reading — the same two guards the plan block
    // needs for the same reason.
    if ((e.target as HTMLElement).closest('a')) return;
    if (window.getSelection()?.toString()) return;
    setOpen(o => !o);
  };

  return frame(
    <>
      {metaKeys.length > 0 ? (
        <div className="mgmt-kv">
          {metaKeys.map(k => (
            <div className="mgmt-kv-row" key={k}>
              <span className="mgmt-kv-key">{k}:</span>
              <span className="mgmt-kv-val">{fm?.data[k]}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="mfileblock">
        {/* No kicker over the name: the section label above the block already
            says what this file is, and the file's own name says the rest. */}
        <div className="mfilehead">
          <span className="mfile-title" title={path}>{baseName(path)}</span>
          {canPreview ? (
            <div className="set-seg mfile-seg" role="group" aria-label="How to show this file">
              <button
                type="button"
                className={rendered ? '' : 'on'}
                aria-pressed={!rendered}
                onClick={() => setPreview(false)}
              >
                Code
              </button>
              <button
                type="button"
                className={rendered ? 'on' : ''}
                aria-pressed={rendered}
                onClick={() => setPreview(true)}
              >
                Preview
              </button>
            </div>
          ) : null}
          {foldable ? (
            <button
              type="button"
              className="mfile-fold"
              aria-expanded={open}
              aria-controls={boxId}
              onClick={() => setOpen(o => !o)}
            >
              {open ? 'collapse' : 'read all'}
              <span className="cv" aria-hidden="true">{open ? '▴' : '▾'}</span>
            </button>
          ) : null}
        </div>
        {file.truncated ? (
          <div className="mgmt-trunc">
            showing first {fmtTok(file.content.length)} of {fmtTok(file.size)} bytes
          </div>
        ) : null}
        {/* A div rather than a <button>: rendered markdown carries links, and an
            <a> inside a <button> is both invalid and unreachable. */}
        <div
          id={boxId}
          className={`mfile-box${expanded ? '' : ' clip'}${foldable ? '' : ' plain'}`}
          role={foldable ? 'button' : undefined}
          tabIndex={foldable ? 0 : undefined}
          aria-expanded={foldable ? open : undefined}
          aria-label={foldable ? (open ? `Collapse ${baseName(path)}` : `Read all of ${baseName(path)}`) : undefined}
          onClick={foldable ? toggle : undefined}
          onKeyDown={e => {
            if (!foldable) return;
            if (e.key !== 'Enter' && e.key !== ' ') return;
            if ((e.target as HTMLElement).closest('a')) return;
            e.preventDefault();
            setOpen(o => !o);
          }}
        >
          {rendered ? <Markdown text={shown} /> : <pre className="mgmt-file">{shown}</pre>}
        </div>
      </div>
    </>
  );
}
