import type { McpServerInfo } from '../../../../shared/types';

interface Props {
  mcp: McpServerInfo;
}

/**
 * Structured MCP server card, shaped like HookDetail but with no FileBlock anywhere: every file that
 * declares a server (~/.claude.json, .mcp.json) holds env values, so none is servable and a FileBlock
 * would draw a 403. Everything shown comes from the API payload, where env/header values are already gone.
 */
export function McpDetail({ mcp }: Props) {
  return (
    <>
      <div className="mdetail-head">
        <span className="mitem-name">{mcp.name}</span>
        <span className="msrc">{mcp.transport}</span>
        <span className={mcp.source.startsWith('plugin:') ? 'msrc plugin' : 'msrc'}>{mcp.source}</span>
        {mcp.disabled ? <span className="msrc">disabled</span> : null}
      </div>
      {mcp.command !== null ? (
        <>
          <div className="mdetail-label">command</div>
          {/* args one per line, so a multi-line `bash -c` script stays readable */}
          <pre className="mgmt-file mgmt-cmd">{[mcp.command, ...mcp.args].join('\n')}</pre>
        </>
      ) : null}
      {mcp.url !== null ? (
        <>
          <div className="mdetail-label">url</div>
          <pre className="mgmt-file mgmt-cmd">{mcp.url}</pre>
        </>
      ) : null}
      {mcp.envKeys.length > 0 ? (
        <>
          <div className="mdetail-label">env · values hidden</div>
          <pre className="mgmt-file mgmt-cmd">{mcp.envKeys.join('\n')}</pre>
        </>
      ) : null}
      {mcp.headerKeys.length > 0 ? (
        <>
          <div className="mdetail-label">headers · values hidden</div>
          <pre className="mgmt-file mgmt-cmd">{mcp.headerKeys.join('\n')}</pre>
        </>
      ) : null}
      <div className="mdetail-label">declared in</div>
      <div className="mitem-desc">{mcp.declaredIn}</div>
    </>
  );
}
