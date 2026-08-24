/**
 * Client-side MCP tool loading — THE architectural difference from the
 * original server. There, the model PROVIDER connected to each MCP server
 * itself (OpenAI Responses `type:'mcp'`, Claude MCP connector) and executed
 * tools provider-side. Here, WE are the MCP client: connect to each
 * resolved server (same URLs/tokens/allowedTools resolveMcpServers already
 * produces, including the ?custom= Apex/Flow registration), pull the tool
 * list as LangChain StructuredTools, and LangGraph's ToolNode executes
 * calls locally. Provider-agnostic by construction — the same tool objects
 * bind to OpenAI, Anthropic, or Gemini models unchanged.
 */
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { logger } from '../logger';
import type { ResolvedMcpServer } from '../chat/adapters/shared';

export interface LoadedMcpTools {
  tools: StructuredToolInterface[];
  /** raw tool name → server label, for ToolCallSummary.serverName. */
  serverByTool: Map<string, string>;
  close: () => Promise<void>;
}

export async function loadMcpTools(servers: ResolvedMcpServer[]): Promise<LoadedMcpTools> {
  const tools: StructuredToolInterface[] = [];
  const serverByTool = new Map<string, string>();
  const clients: MultiServerMCPClient[] = [];

  // One client per server (not one multi-client) so each server's
  // allowedTools filter applies to ITS tools only, and one cold/broken
  // server skips instead of failing the whole load.
  for (const s of servers) {
    try {
      const client = new MultiServerMCPClient({
        mcpServers: {
          [s.name]: {
            transport: 'http',
            url: s.url,
            headers: { Authorization: `Bearer ${s.token}` },
          },
        },
        // Tool names must stay EXACTLY as the server publishes them —
        // allowedTools from Salesforce and the model's own calls both use
        // raw names, same as the provider-hosted setup enforced.
        prefixToolNameWithServerName: false,
        additionalToolNamePrefix: '',
      });
      const loaded = await client.getTools();
      clients.push(client);
      const allowed = new Set(s.allowedTools);
      let kept = 0;
      for (const t of loaded) {
        if (allowed.size > 0 && !allowed.has(t.name)) continue;
        if (serverByTool.has(t.name)) {
          logger.warn({ tool: t.name, server: s.name }, 'mcp_tool_name_collision_skipped');
          continue;
        }
        serverByTool.set(t.name, s.name);
        tools.push(t);
        kept++;
      }
      logger.info({ server: s.name, total: loaded.length, kept }, 'mcp_tools_loaded');
    } catch (err) {
      // Mirror of the original's degrade-don't-die stance on cold hosts:
      // a server that can't be reached loses ITS tools for this turn only.
      logger.error({ server: s.name, url: s.url, err: err instanceof Error ? err.message : err }, 'mcp_tools_load_failed');
    }
  }

  return {
    tools,
    serverByTool,
    close: async () => {
      await Promise.allSettled(clients.map(c => c.close()));
    },
  };
}
