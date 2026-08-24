/**
 * MCP server registry — lookup by name.
 *
 * Right now each MCP server exposes its own typed functions (callClaude,
 * sfGetRecord, ...). This registry is a placeholder for when we move to
 * the real MCP wire protocol (stdio or HTTP) and want to dynamically
 * dispatch by `node.mcpServer` + `node.mcpTool`.
 */

export const MCP_SERVERS = [
  'anthropic',
  'openai',
  'gemini',
  'salesforce-crm',
  'salesforce-einstein',
  'email',
  'channels',
  'storage',
] as const;

export type McpServerName = (typeof MCP_SERVERS)[number];

export function isKnownMcpServer(name: string | null | undefined): name is McpServerName {
  return !!name && (MCP_SERVERS as readonly string[]).includes(name);
}
