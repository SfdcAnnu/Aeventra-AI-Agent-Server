/**
 * Build a turn's connectors from the agent's own catalog nodes.
 *
 * WHY THIS EXISTS. `connectors[]` describes which MCP servers an agent may
 * reach, and it used to arrive only from the caller. Apex builds it for the
 * HTTP path; the WebSocket path takes whatever the browser sends — and the
 * browser sends none, because a chat client has no business knowing MCP
 * server URLs, tokens or catalog metadata.
 *
 * The consequence was silent and expensive. With no connectors,
 * resolveMcpServers fell through to a legacy env-configured fallback, so an
 * agent tested in the builder ran against a different Salesforce MCP server
 * than the same agent running in production — and when that fallback could
 * not be reached, the agent simply had no tools. Live: a Sales Desk agent
 * with seven Salesforce tools attached went to the model carrying only
 * `read_artifact` and its three specialist handoffs.
 *
 * The server already holds everything needed to derive this: the agent with
 * its nodes, and an org connection. So it derives it, and the client stops
 * being asked for infrastructure it cannot know. Deliberately a mirror of
 * AgentChatController.buildConnectorsPayload — if the two disagree, an
 * agent behaves differently in test than in production, which is the exact
 * failure this replaces.
 */
import type { Connection } from 'jsforce';
import { logger } from '../logger';
import type { AgentDefinition } from '../types';
import type { ConnectorInput } from '../chat/adapters/types';

interface CatalogConfig {
  provider?: unknown;
  connectorId?: unknown;
  allowedTools?: unknown;
  customTools?: unknown;
}

/**
 * Returns one entry per enabled catalog node whose provider has a server URL
 * registered in the org. A node naming an unknown provider is skipped rather
 * than guessed at — a wrong URL is worse than a missing tool.
 *
 * Never throws: a failure here must degrade to "no connectors" (which the
 * runtime now reports honestly to the model) rather than fail the turn.
 */
export async function connectorsForAgent(
  conn: Connection,
  agent: AgentDefinition,
): Promise<ConnectorInput[]> {
  try {
    const catalogNodes = agent.nodes.filter(n => n.nodeType === 'catalog' && n.isEnabled);
    if (catalogNodes.length === 0) return [];

    const urlByProvider = new Map<string, string>();
    const rows = await conn.query<{ DeveloperName: string; McpServerUrl__c?: string | null }>(
      'SELECT DeveloperName, McpServerUrl__c FROM ConnectorCatalog__mdt WHERE McpServerUrl__c != null',
    );
    for (const r of rows.records) {
      if (r.McpServerUrl__c) urlByProvider.set(r.DeveloperName, r.McpServerUrl__c.replace(/\/+$/, ''));
    }

    const out: ConnectorInput[] = [];
    for (const node of catalogNodes) {
      const cfg = (node.config ?? {}) as CatalogConfig;
      const provider = typeof cfg.provider === 'string' ? cfg.provider : '';
      const url = urlByProvider.get(provider);
      if (!provider || !url) {
        logger.warn({ agent: agent.apiName, provider }, 'connector_provider_not_registered');
        continue;
      }

      const allowedTools = Array.isArray(cfg.allowedTools)
        ? cfg.allowedTools.filter((t): t is string => typeof t === 'string')
        : [];

      const customTools = Array.isArray(cfg.customTools)
        ? cfg.customTools
            .filter((t): t is { type: string; name: string; label?: string } =>
              !!t && typeof t === 'object' &&
              typeof (t as { type?: unknown }).type === 'string' &&
              typeof (t as { name?: unknown }).name === 'string')
            .map(t => ({ type: t.type, name: t.name, label: t.label ?? null }))
        : [];

      out.push({
        provider,
        mcpServerUrl: url,
        allowedTools,
        connectorId: typeof cfg.connectorId === 'string' && cfg.connectorId ? cfg.connectorId : null,
        // Access mode travels with the Salesforce connector so the server
        // refuses to fall back to the org token on a PerUser agent.
        accessMode: provider === 'salesforce_mcp' ? (agent.accessMode ?? 'Org') : null,
        customTools,
      });
    }
    return out;
  } catch (err) {
    logger.error(
      { agent: agent.apiName, err: err instanceof Error ? err.message : err },
      'connectors_for_agent_failed',
    );
    return [];
  }
}
