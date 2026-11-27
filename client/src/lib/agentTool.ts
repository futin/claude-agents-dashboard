/**
 * Whether a tool name is a subagent launch, the one tool the rows paint magenta (`.tool.task`).
 *
 * Claude Code renamed that tool from `Task` to `Agent`; the server passes the transcript's name through unchanged, so older transcripts still say `Task`
 * and every current one says `Agent` (#594). The server's own check is `isAgentLaunch` in `server/lib/agents.ts`.
 */
export function isAgentTool(name: string | undefined | null): boolean {
  return name === 'Agent' || name === 'Task';
}
