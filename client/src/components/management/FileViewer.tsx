import { useFileContent } from '../../hooks/useManagement';
import { fmtTok } from '../../lib/format';

interface Props {
  path: string;
  /** Pretty-print JSON content; falls back to raw on parse error or truncation. */
  pretty?: boolean;
}

function prettyJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

/** Fetches and renders one servable file as monospace text. */
export function FileViewer({ path, pretty = false }: Props) {
  const { file, loading, error } = useFileContent(path);

  if (loading) return <div className="mgmt-empty">loading…</div>;
  if (error) return <div className="mgmt-empty off">couldn't load this file</div>;
  if (file === null) return null;

  const content = pretty && !file.truncated ? prettyJson(file.content) : file.content;

  return (
    <>
      {file.truncated ? (
        <div className="mgmt-trunc">showing first {fmtTok(file.content.length)} of {fmtTok(file.size)} bytes</div>
      ) : null}
      <pre className="mgmt-file">{content === '' ? '(empty file)' : content}</pre>
    </>
  );
}
