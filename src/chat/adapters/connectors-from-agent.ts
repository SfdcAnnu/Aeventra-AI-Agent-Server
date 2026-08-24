/**
 * Server-side equivalent of AgentChatController.buildConnectorsPayload —
 * flow runs have no per-turn Apex round trip to attach connectors[], so we
 * build the same shape here from the agent definition already in memory
 * plus one SOQL for ConnectorCatalog__mdt (custom metadata, safe to read
 * with the org's own connection).
 */
import type { Connection } from 'jsforce';
import type { AgentDefinition, AgentNode } from '../../types';
import type { ConnectorInput } from './types';

/**
 * Scoped to ONE AI node's own downstream catalogs — NOT every catalog node
 * in the agent. A flow can have several AI nodes, each wired to a different
 * catalog (same connector, different allowedTools per node — the whole
 * point of the per-node tool-scoping feature). Aggregating agent-wide would
 * silently union every node's tools into every other node's call.
 */
export async function buildConnectorInputsFromAgent(
  agent: AgentDefinition,
  aiNode: AgentNode,
  conn: Connection,
): Promise<ConnectorInput[]> {
  const canvas = agent.canvasJson as { connections?: Array<{ fromIndex?: number; toIndex?: number }> } | undefined;
  const connections = canvas?.connections ?? [];

  const catalogNodes = agent.nodes.filter(n =>
    n.nodeType === 'catalog' &&
    n.isEnabled &&
    connections.some(c => {
      const from = agent.nodes[c.fromIndex ?? -1]?.id;
      const to   = agent.nodes[c.toIndex   ?? -1]?.id;
      return from === aiNode.id && to === n.id;
    }),
  );
  if (catalogNodes.length === 0) return [];

  const res = await conn.query<{ DeveloperName: string; McpServerUrl__c?: string }>(
    'SELECT DeveloperName, McpServerUrl__c FROM ConnectorCatalog__mdt',
  );
  const urlByProvider = new Map<string, string>();
  for (const row of res.records) {
    if (row.McpServerUrl__c) urlByProvider.set(row.DeveloperName, row.McpServerUrl__c.replace(/\/+$/, ''));
  }

  // Custom/client-added MCP servers — same open-extension-point pattern as
  // Claude's own "add a custom MCP server" — providerKey is 'custom_<Id>'
  // (see AgentConnectorController.getDirectory), so any catalog node bound
  // to one resolves its URL here exactly like a packaged provider does.
  const customRes = await conn.query<{ Id: string; McpServerUrl__c?: string }>(
    'SELECT Id, McpServerUrl__c FROM CustomMcpServer__c WHERE IsActive__c = true',
  );
  for (const row of customRes.records) {
    if (row.McpServerUrl__c) urlByProvider.set(`custom_${row.Id}`, row.McpServerUrl__c.replace(/\/+$/, ''));
  }

  const out: ConnectorInput[] = [];
  for (const n of catalogNodes) {
    const cfg = n.config ?? {};
    const provider = cfg.provider as string | undefined;
    if (!provider || !urlByProvider.has(provider)) continue;

    const allowedTools = Array.isArray(cfg.allowedTools) ? (cfg.allowedTools as string[]) : [];
    const customToolsRaw = Array.isArray(cfg.customTools)
      ? (cfg.customTools as Array<{ type: string; name: string; label?: string }>)
      : [];

    out.push({
      provider,
      mcpServerUrl: urlByProvider.get(provider)!,
      allowedTools,
      connectorId: (cfg.connectorId as string) || null,
      accessMode: provider === 'salesforce_mcp' ? (agent.accessMode ?? 'Org') : null,
      customTools: customToolsRaw.length > 0 ? customToolsRaw : null,
    });
  }
  return out;
}
