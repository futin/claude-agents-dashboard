import { Fragment } from 'react';

import { parseFrontmatter } from '../../../../shared/frontmatter';
import { useFileContent } from '../../hooks/useManagement';
import { fmtTok } from '../../lib/format';

interface Props {
  path: string;
}

/**
 * Markdown file view: the YAML frontmatter block becomes a key/value table
 * (the machine-oriented noise), the body stays honest monospace text.
 */
export function MarkdownViewer({ path }: Props) {
  const { file, loading, error } = useFileContent(path);

  if (loading) return <div className="mgmt-empty">loading…</div>;
  if (error) return <div className="mgmt-empty off">couldn't load this file</div>;
  if (file === null) return null;
  if (file.content === '') return <pre className="mgmt-file">(empty file)</pre>;

  const { data, body } = parseFrontmatter(file.content);
  const keys = Object.keys(data);

  return (
    <>
      {file.truncated ? (
        <div className="mgmt-trunc">showing first {fmtTok(file.content.length)} of {fmtTok(file.size)} bytes</div>
      ) : null}
      {keys.length > 0 ? (
        <div className="mgmt-kv">
          {keys.map(k => (
            <Fragment key={k}>
              <span className="mgmt-kv-key">{k}</span>
              <span className="mgmt-kv-val">{data[k]}</span>
            </Fragment>
          ))}
        </div>
      ) : null}
      <pre className="mgmt-file">{keys.length > 0 ? body : file.content}</pre>
    </>
  );
}
