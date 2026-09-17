/**
 * Connections derived from tool nodes.
 *
 * A tool catalog node is the agent's connection to one MCP server: where it
 * is and how to sign in. An MCP tool node names its server as well — its
 * connectorId is the provider key the builder's tool form set — so an agent
 * whose tool nodes name a server that has NO catalog node still has all the
 * runtime needs: the address from ConnectorCatalog__mdt (or an active
 * CustomMcpServer__c row), the token from the token store. That is how the
 * platform's own copilot is wired: sixty tool nodes, no catalogs.
 *
 * Connections made this way are strictly scoped per node — see
 * connector-scope.ts. Catalog connections already on the request are left
 * exactly as they were.
 */
import type { Connection } from 'jsforce';
import { logger } from '../logger';
import type { AgentDefinition } from '../types';
import type { ConnectorInput } from './adapters/types';
import { METADATA_PROVIDER, PLATFORM_PROVIDER, SALESFORCE_TOKEN_PROVIDERS, providerOfAction } from './connector-scope';

/** The Archon server's own tool endpoint. In-process client, so loopback
 *  unless an operator points it elsewhere (a multi-instance deployment). */
export function platformBaseUrl(): string {
  const explicit = process.env.PLATFORM_TOOLS_URL?.replace(/\/+$/, '');
  if (explicit) return explicit;
  const port = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 3000;
  return `http://127.0.0.1:${port}/platform`;
}

/** Header the Salesforce Metadata server reads when a token has no id scope. */
const INSTANCE_URL_HEADER = 'X-Salesforce-Instance-Url';

// ── Provider → base URL, per org, briefly cached ──────────────────────
const URL_CACHE_TTL_MS = 5 * 60 * 1000;
const urlCache = new Map<string, { urls: Map<string, string>; fetchedAt: number }>();

export async function providerUrls(conn: Connection, orgKey: string): Promise<Map<string, string>> {
  const hit = urlCache.get(orgKey);
  if (hit && Date.now() - hit.fetchedAt < URL_CACHE_TTL_MS) return hit.urls;
  const urls = new Map<string, string>();
  const rows = await conn.query<{ DeveloperName: string; McpServerUrl__c?: string | null }>(
    'SELECT DeveloperName, McpServerUrl__c FROM ConnectorCatalog__mdt WHERE McpServerUrl__c != null',
  );
  for (const r of rows.records) if (r.McpServerUrl__c) urls.set(r.DeveloperName, r.McpServerUrl__c.replace(/\/+$/, ''));
  try {
    const custom = await conn.query<{ Id: string; McpServerUrl__c?: string | null }>(
      'SELECT Id, McpServerUrl__c FROM CustomMcpServer__c WHERE IsActive__c = true',
    );
    for (const r of custom.records) if (r.McpServerUrl__c) urls.set(`custom_${r.Id}`, r.McpServerUrl__c.replace(/\/+$/, ''));
  } catch {
    /* org without the custom-server object */
  }
  urlCache.set(orgKey, { urls, fetchedAt: Date.now() });
  return urls;
}

/** Tests and the sync endpoint: forget cached addresses for an org. */
export function forgetProviderUrls(orgKey?: string): void {
  if (orgKey) urlCache.delete(orgKey);
  else urlCache.clear();
}

/** Every provider some enabled tool node of the agent names. */
export function providersNamedByToolNodes(agent: AgentDefinition): Set<string> {
  const out = new Set<string>();
  for (const n of agent.nodes) {
    if (n.nodeType !== 'tool' || !n.isEnabled) continue;
    const cfg = (n.config ?? {}) as { actionType?: string; connectorId?: string };
    const provider = providerOfAction({
      actionType: (cfg.actionType as 'MCP' | 'Apex' | 'Flow' | 'Prebuilt') ?? 'MCP',
      connectorId: cfg.connectorId ?? null,
    });
    if (provider) out.add(provider);
  }
  return out;
}

/**
 * Add a strictly scoped connection for every provider the agent's tool
 * nodes name that the request does not already carry. Catalog connections
 * win when both exist for the same provider.
 */
export async function augmentConnectorsWithToolNodes(
  agent: AgentDefinition,
  connectors: ConnectorInput[],
  conn: Connection,
  sfInstanceUrl: string | null | undefined,
): Promise<ConnectorInput[]> {
  const present = new Set(connectors.map(c => c.provider));
  const wanted = [...providersNamedByToolNodes(agent)].filter(p => !present.has(p));
  if (wanted.length === 0) return connectors;

  const out = [...connectors];
  let urls: Map<string, string> | null = null;
  for (const provider of wanted) {
    let url: string | undefined;
    if (provider === PLATFORM_PROVIDER) {
      url = platformBaseUrl();
    } else {
      urls ??= await providerUrls(conn, conn.instanceUrl ?? agent.apiName);
      url = urls.get(provider);
    }
    if (!url) {
      logger.warn({ agent: agent.apiName, provider }, 'tool_node_provider_not_registered');
      continue;
    }
    out.push({
      provider,
      mcpServerUrl: url,
      allowedTools: [],
      connectorId: null,
      accessMode: SALESFORCE_TOKEN_PROVIDERS.has(provider) ? (agent.accessMode ?? 'Org') : null,
      customTools: null,
      scope: 'nodes',
      headers: provider === METADATA_PROVIDER && sfInstanceUrl ? { [INSTANCE_URL_HEADER]: sfInstanceUrl } : null,
    });
  }
  return out;
}
