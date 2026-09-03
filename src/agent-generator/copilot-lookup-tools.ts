/**
 * Live org-metadata lookup tools for the builder Copilot — the difference
 * between "guessing field names" and "grounded in reality". The copilot
 * model calls these mid-conversation (describe an object before writing a
 * guardrail's targetField, list invocable actions before wiring one) and
 * the server executes them against the org connection; only MUTATION tools
 * remain propose-only.
 *
 * Read-only by construction: describes and action lists, never DML, never
 * action invocation (verifying a "send invoice" action by running it would
 * send an invoice).
 */
import { getOrgConnection } from '../salesforce/per-org-connection';
import { resolveProviderToken } from '../chat/adapters/shared';
import { mcpListTools } from '../mcp/clients/streamable-http-client';
import { InstallsRepo } from '../db/installs.repo';
import { logger } from '../logger';

const SAFE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,80}$/;
const API_VERSION = '62.0';
const MAX_FIELDS = 80;
const MAX_PICKLIST_VALUES = 15;

export const LOOKUP_TOOL_NAMES = new Set(['describe_object', 'list_custom_actions', 'list_connected_tools']);

// OpenAI Responses API flat function-tool shape, same as copilot.ts's
// mutation tools.
export const LOOKUP_TOOLS = [
  {
    type: 'function',
    name: 'describe_object',
    description: 'Get the REAL fields of a Salesforce object in this org: API names, labels, types, required flags, and picklist values. ALWAYS call this before writing any config that references a field — never invent field API names.',
    parameters: {
      type: 'object',
      properties: { objectName: { type: 'string', description: 'Object API name, e.g. "Opportunity", "Product2", "Invoice__c".' } },
      required: ['objectName'],
    },
  },
  {
    type: 'function',
    name: 'list_custom_actions',
    description: "List this org's invocable Apex actions and autolaunched Flows (name + label, namespace included) — the candidates for tool nodes with actionType Apex/Flow.",
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'list_connected_tools',
    description: 'List the live MCP tools actually available in this org, per connected provider — only these tool names may be used in catalog allowedTools or MCP tool nodes.',
    parameters: { type: 'object', properties: {} },
  },
];

export async function executeLookupTool(
  orgId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    if (name === 'describe_object') return await describeObject(orgId, String(args.objectName ?? ''));
    if (name === 'list_custom_actions') return await listCustomActions(orgId);
    if (name === 'list_connected_tools') return await listConnectedTools(orgId);
    return `Unknown lookup tool "${name}".`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ orgId, tool: name, err: msg }, 'copilot_lookup_failed');
    return `Lookup failed: ${msg.slice(0, 300)}. Tell the user what you could not verify instead of guessing.`;
  }
}

async function describeObject(orgId: string, objectName: string): Promise<string> {
  if (!SAFE_NAME_RE.test(objectName)) return `Invalid object name "${objectName}".`;
  const conn = await getOrgConnection(orgId);
  const desc = await (conn.sobject(objectName) as unknown as {
    describe: () => Promise<{ fields: Array<{
      name: string; label: string; type: string; nillable: boolean; updateable: boolean;
      picklistValues?: Array<{ value: string; active: boolean }>;
    }> }>;
  }).describe();

  const lines = desc.fields.slice(0, MAX_FIELDS).map(f => {
    let line = `${f.name} (${f.label}) type=${f.type}${f.nillable ? '' : ' REQUIRED'}${f.updateable ? '' : ' read-only'}`;
    if ((f.type === 'picklist' || f.type === 'multipicklist') && f.picklistValues?.length) {
      const values = f.picklistValues.filter(v => v.active).slice(0, MAX_PICKLIST_VALUES).map(v => v.value);
      line += ` values=[${values.join(', ')}]`;
    }
    return line;
  });
  const truncated = desc.fields.length > MAX_FIELDS ? `\n(+${desc.fields.length - MAX_FIELDS} more fields not shown)` : '';
  return `${objectName} fields:\n${lines.join('\n')}${truncated}`;
}

async function listCustomActions(orgId: string): Promise<string> {
  const conn = await getOrgConnection(orgId);
  const out: string[] = [];
  for (const type of ['apex', 'flow'] as const) {
    try {
      const r = await conn.request<{ actions?: Array<{ name: string; label?: string }> }>(
        `/services/data/v${API_VERSION}/actions/custom/${type}`);
      for (const a of (r?.actions ?? []).slice(0, 60)) out.push(`${type}: ${a.name}${a.label && a.label !== a.name ? ` ("${a.label}")` : ''}`);
    } catch {
      out.push(`(could not list ${type} actions)`);
    }
  }
  return out.length ? out.join('\n') : '(no invocable Apex actions or autolaunched Flows found)';
}

async function listConnectedTools(orgId: string): Promise<string> {
  const conn = await getOrgConnection(orgId);
  const install = await InstallsRepo.findByOrgId(orgId);
  const rows = await conn.query<{ DeveloperName: string; McpServerUrl__c?: string }>(
    'SELECT DeveloperName, McpServerUrl__c FROM ConnectorCatalog__mdt WHERE McpServerUrl__c != null',
  );
  const out: string[] = [];
  for (const row of rows.records) {
    try {
      const token = await resolveProviderToken({
        orgId, userId: '', provider: row.DeveloperName, connectorId: null,
        sfAccessToken: install?.sfAccessToken ?? null,
      });
      if (!token) continue;
      const tools = await mcpListTools({ remoteUrl: row.McpServerUrl__c!, accessToken: token });
      out.push(`${row.DeveloperName}: ${tools.map(t => t.name).join(', ')}`);
    } catch {
      out.push(`${row.DeveloperName}: (unreachable)`);
    }
  }
  return out.length ? out.join('\n') : '(no connected MCP providers)';
}
