/**
 * Generic "Call a Tool" action node — the deterministic counterpart to AI
 * tool-calling. Instead of a fixed list of hardcoded node types
 * (get_record/update_record/create_record/...), an admin picks a connector
 * (Salesforce/Gmail/Outlook/custom Apex/Flow action) and one specific tool
 * from its REAL catalog, and this node calls it directly with admin-filled
 * (and {!interpolatable}) parameter values — no AI judgment involved.
 *
 * Same tool catalogs the AI orchestrator uses (Managed MCP for standard
 * tools, invocable Actions API for custom Apex/Flow) — one source of truth
 * for "what can this org do," reused instead of reimplemented.
 */
import { register } from './registry';
import type { NodeExecutor } from './registry';
import { InstallsRepo } from '../db/installs.repo';
import { resolveProviderToken } from '../chat/adapters/shared';
import { callMcpTool, safeBaseUrl } from '../mcp/mcp-client';
import { logger } from '../logger';

interface CallToolConfig {
  provider?: string;         // ConnectorCatalog__mdt DeveloperName, e.g. 'salesforce_mcp'
  connectorId?: string;      // Node-side Connector row id — non-Salesforce providers
  toolKind?: 'standard' | 'custom';
  toolName?: string;         // standard MCP tool name, or Apex class / Flow API name
  customToolType?: 'apex' | 'flow';
  paramValues?: Record<string, string>;
  outputVariable?: string;
}

const callToolExec: NodeExecutor = async (node, ctx) => {
  const config = (node.config as CallToolConfig) || {};
  const provider = config.provider;
  const toolName = config.toolName;
  if (!provider || !toolName) {
    return { nodeId: node.id, nodeSubType: 'call_tool', success: false, error: 'Call a Tool node is not configured — pick a connector and a tool.' };
  }

  // Interpolate every param value, then best-effort JSON coercion so
  // numbers/booleans/arrays survive instead of arriving as strings.
  const rawParams = config.paramValues ?? {};
  const inputs: Record<string, unknown> = {};
  for (const [key, template] of Object.entries(rawParams)) {
    const interpolated = ctx.interpolate(String(template ?? ''));
    if (interpolated === '') continue;
    try { inputs[key] = JSON.parse(interpolated); }
    catch { inputs[key] = interpolated; }
  }

  try {
    if (config.toolKind === 'custom') {
      // Custom Apex action / Flow — same invocable-actions REST API the
      // Salesforce MCP server's custom-tools use, called directly here
      // since Archon's own ctx.conn is already an org-scoped connection.
      const actionType = config.customToolType === 'flow' ? 'flow' : 'apex';
      const res = await ctx.conn.request<Array<{ isSuccess: boolean; outputValues: Record<string, unknown> | null; errors: unknown }>>({
        method: 'POST',
        url: `/services/data/v${ctx.conn.version}/actions/custom/${actionType}/${encodeURIComponent(toolName)}`,
        body: JSON.stringify({ inputs: [inputs] }),
        headers: { 'Content-Type': 'application/json' },
      });
      const r = res?.[0];
      if (r?.isSuccess !== true) {
        return { nodeId: node.id, nodeSubType: 'call_tool', success: false, error: JSON.stringify(r?.errors ?? 'unknown error') };
      }
      return {
        nodeId: node.id, nodeSubType: 'call_tool', success: true,
        output: { toolName, kind: 'custom', result: r.outputValues ?? {} },
        customAlias: config.outputVariable || undefined,
        toolsUsed: [`${provider}:${toolName}`],
      };
    }

    // Standard MCP tool — resolve the provider's server URL + token, one-shot call.
    const urlRes = await ctx.conn.query<{ McpServerUrl__c?: string }>(
      `SELECT McpServerUrl__c FROM ConnectorCatalog__mdt WHERE DeveloperName = '${provider.replace(/'/g, "\\'")}' LIMIT 1`,
    );
    const baseUrl = urlRes.records[0]?.McpServerUrl__c;
    if (!baseUrl) {
      return { nodeId: node.id, nodeSubType: 'call_tool', success: false, error: `No McpServerUrl__c configured for provider "${provider}".` };
    }

    const install = await InstallsRepo.findByOrgId(ctx.orgId);
    const token = await resolveProviderToken({
      orgId: ctx.orgId, userId: ctx.userId, provider,
      connectorId: config.connectorId, accessMode: ctx.agent.accessMode,
      sfAccessToken: install?.sfAccessToken ?? null,
    });
    if (!token) {
      return { nodeId: node.id, nodeSubType: 'call_tool', success: false, error: `No connected account for provider "${provider}" — connect it on the Auth tab first.` };
    }

    const result = await callMcpTool(safeBaseUrl(baseUrl), token, toolName, inputs);
    logger.info({ nodeId: node.id, provider, toolName, orgId: ctx.orgId }, 'call_tool_executed');
    return {
      nodeId: node.id, nodeSubType: 'call_tool', success: true,
      output: { toolName, kind: 'standard', result },
      customAlias: config.outputVariable || undefined,
      toolsUsed: [`${provider}:${toolName}`],
    };
  } catch (err) {
    logger.error({ err, nodeId: node.id, provider, toolName }, 'call_tool_failed');
    return { nodeId: node.id, nodeSubType: 'call_tool', success: false, error: (err as Error).message };
  }
};

register('call_tool', callToolExec);
