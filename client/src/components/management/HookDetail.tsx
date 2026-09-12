import { FileBlock } from './FileBlock';
import type { HookInfo } from '../../../../shared/types';

interface Props {
  hook: HookInfo;
}

/**
 * Structured hook card — event, matcher, command, and the resolved script's
 * content. The declaring settings/hooks file is no longer behind a bespoke
 * `show file` toggle: it is the same foldable FileBlock every other file on
 * the page gets, so it reads (and folds) like all of them.
 */
export function HookDetail({ hook }: Props) {
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
          <FileBlock path={hook.scriptPath} kind="text" />
        </>
      ) : null}
      <div className="mdetail-label">declared in</div>
      <FileBlock path={hook.declaredIn} kind="json" />
    </>
  );
}
