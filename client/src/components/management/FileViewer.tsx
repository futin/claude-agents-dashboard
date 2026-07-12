import { useFileContent } from '../../hooks/useManagement';
import { fmtTok } from '../../lib/format';

interface Props {
  path: string;
}

/** Fetches and renders one servable file as monospace text. */
export function FileViewer({ path }: Props) {
  const { file, loading, error } = useFileContent(path);

  if (loading) return <div className="mgmt-empty">loading…</div>;
  if (error) return <div className="mgmt-empty off">couldn't load this file</div>;
  if (file === null) return null;

  return (
    <>
      {file.truncated ? (
        <div className="mgmt-trunc">showing first {fmtTok(file.content.length)} of {fmtTok(file.size)} bytes</div>
      ) : null}
      <pre className="mgmt-file">{file.content === '' ? '(empty file)' : file.content}</pre>
    </>
  );
}
