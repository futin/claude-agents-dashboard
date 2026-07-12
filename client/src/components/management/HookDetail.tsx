import { useState } from 'react';

import { FileViewer } from './FileViewer';
import type { HookInfo } from '../../../../shared/types';

interface Props {
  hook: HookInfo;
}

/**
 * Structured hook card — event, matcher, command, and the resolved script's
 * content. The declaring settings/hooks file is behind a toggle so nobody has
 * to hunt through the whole JSON array again; FileViewer only mounts (and
 * fetches) once toggled.
 */
export function HookDetail({ hook }: Props) {
  const [showDeclaring, setShowDeclaring] = useState(false);

  return (
    <>
      <div className="mdetail-head">
        <span className="mitem-name">{hook.event}</span>
        <span className="msrc">{hook.matcher ?? 'all tools'}</span>
        <span className={hook.source.startsWith('plugin:') ? 'msrc plugin' : 'msrc'}>{hook.source}</span>
      </div>
      <div className="mdetail-label">command</div>
      <pre className="mgmt-file mgmt-cmd">{hook.command}</pre>
      {hook.scriptPath !== null ? (
        <>
          <div className="mdetail-label">script</div>
          <div className="mdetail-path">{hook.scriptPath}</div>
          <FileViewer path={hook.scriptPath} />
        </>
      ) : null}
      <div className="mdetail-label">
        declared in
        <button className="tb-dir" onClick={() => setShowDeclaring(s => !s)}>
          {showDeclaring ? 'hide file' : 'show file'}
        </button>
      </div>
      <div className="mdetail-path">{hook.declaredIn}</div>
      {showDeclaring ? <FileViewer path={hook.declaredIn} pretty /> : null}
    </>
  );
}
