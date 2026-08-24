import jsforce, { Connection } from 'jsforce';
import { config } from '../config';
import { logger } from '../logger';
import type { AgentDefinition, AgentNode } from '../types';

/**
 * Salesforce OAuth 2.0 Client Credentials Flow.
 *
 * Setup in Salesforce (one-time):
 *   1. Setup → External Client App Manager → New External Client App
 *   2. Enable OAuth, set "Run As" user, enable "Client Credentials Flow"
 *   3. Get the Consumer Key (SF_CLIENT_ID) and Consumer Secret (SF_CLIENT_SECRET)
 *
 * Flow:
 *   - POST /services/oauth2/token with grant_type=client_credentials + client_id + client_secret
 *   - SF returns { access_token, instance_url, ... }
 *   - All operations run as the "Run As" user configured on the External Client App
 *
 * Connection is cached for 30 minutes. If the access token expires mid-session,
 * jsforce surfaces an INVALID_SESSION_ID error — call `clearConnection()` and retry.
 */

let cachedConn: Connection | null = null;
let cachedAt = 0;
const CONN_TTL_MS = 30 * 60 * 1000;

interface TokenResponse {
  access_token: string;
  instance_url: string;
  id: string;
  token_type: string;
  signature?: string;
  issued_at?: string;
}

async function loginViaClientCredentials(): Promise<Connection> {
  if (!config.salesforce.clientId || !config.salesforce.clientSecret) {
    throw new Error(
      'Salesforce Client Credentials login not configured — set SF_CLIENT_ID and SF_CLIENT_SECRET in server/.env',
    );
  }

  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', config.salesforce.clientId);
  params.append('client_secret', config.salesforce.clientSecret);

  const tokenUrl = `${config.salesforce.loginUrl.replace(/\/$/, '')}/services/oauth2/token`;
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Salesforce Client Credentials login failed (${response.status}): ${errBody}`);
  }

  const tok = (await response.json()) as TokenResponse;

  const conn = new Connection({
    instanceUrl: tok.instance_url,
    accessToken: tok.access_token,
    version: '62.0',
  });

  logger.info({ instanceUrl: tok.instance_url }, 'salesforce_connected_via_client_credentials');
  return conn;
}

export async function getConnection(): Promise<Connection> {
  if (cachedConn && Date.now() - cachedAt < CONN_TTL_MS) return cachedConn;
  cachedConn = await loginViaClientCredentials();
  cachedAt = Date.now();
  return cachedConn;
}

/** Invalidate the cached connection — call when the token is rejected. */
export function clearConnection(): void {
  cachedConn = null;
  cachedAt = 0;
}

/** Load an agent definition + all nodes from Salesforce by ApiName__c. */
export async function loadAgentDefinition(apiName: string, connOverride?: Connection): Promise<AgentDefinition | null> {
  const conn = connOverride ?? await getConnection();

  const result = await conn.query<{
    Id: string;
    Name: string;
    ApiName__c: string;
    Department__c: string;
    KnowledgeBase__c?: string;
    Status__c: 'Active' | 'Draft' | 'Inactive';
    AccessMode__c?: string;
    CanvasJson__c?: string;
    ExternalServerUrl__c?: string;
  }>(
    `SELECT Id, Name, ApiName__c, Department__c, KnowledgeBase__c, Status__c, AccessMode__c, CanvasJson__c, ExternalServerUrl__c
     FROM AgentDefinition__c
     WHERE ApiName__c = '${apiName.replace(/'/g, "\\'")}'
     LIMIT 1`,
  );
  if (result.records.length === 0) return null;
  const def = result.records[0];

  const nodesQuery = await conn.query<{
    Id: string;
    Name: string;
    NodeType__c: string;
    NodeSubType__c: string;
    ConfigJson__c?: string;
    PositionX__c: number;
    PositionY__c: number;
    SortOrder__c: number;
    IsEnabled__c: boolean;
    McpServer__c?: string;
    McpTool__c?: string;
  }>(
    `SELECT Id, Name, NodeType__c, NodeSubType__c, ConfigJson__c,
            PositionX__c, PositionY__c, SortOrder__c, IsEnabled__c, McpServer__c, McpTool__c
     FROM AgentNode__c
     WHERE AgentDefinition__c = '${def.Id}'
     ORDER BY SortOrder__c ASC`,
  );

  const nodes: AgentNode[] = nodesQuery.records.map((r: any) => ({
    id: r.Id,
    name: r.Name,
    nodeType: r.NodeType__c,
    nodeSubType: r.NodeSubType__c,
    config: r.ConfigJson__c ? safeJson(r.ConfigJson__c) : {},
    positionX: r.PositionX__c ?? 0,
    positionY: r.PositionY__c ?? 0,
    sortOrder: r.SortOrder__c ?? 0,
    isEnabled: r.IsEnabled__c !== false,
    mcpServer: r.McpServer__c ?? null,
    mcpTool: r.McpTool__c ?? null,
  }));

  return {
    id: def.Id,
    name: def.Name,
    apiName: def.ApiName__c,
    department: def.Department__c,
    knowledgeBase: def.KnowledgeBase__c,
    status: def.Status__c,
    accessMode: def.AccessMode__c,
    canvasJson: def.CanvasJson__c ? safeJson(def.CanvasJson__c) : undefined,
    externalServerUrl: def.ExternalServerUrl__c,
    nodes,
  };
}

function safeJson<T = unknown>(s: string): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return {} as T;
  }
}
