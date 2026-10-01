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
import '../chat/adapters/shared';   // registers the token freshener the resolver uses
import { resolveIdentity } from '../identity/resolver';
import { identityInputFromConfig, policyFor } from '../identity/policy';
import { OrgIdentityPolicyRepo, ServerOverrideRepo } from '../db/identity.repo';
import { SALESFORCE_TOKEN_PROVIDERS } from '../chat/connector-scope';
import { callMcpTool, safeBaseUrl } from '../mcp/mcp-client';
import { logger } from '../logger';
import { pkgConn } from '../salesforce/namespace';

interface CallToolConfig {
  provider?: string;         // ConnectorCatalog__mdt DeveloperName, e.g. 'salesforce_mcp'
  connectorId?: string;      // Node-side Connector row id — non-Salesforce providers
  toolKind?: 'standard' | 'custom';
  toolName?: string;         // standard MCP tool name, or Apex class / Flow API name
  customToolType?: 'apex' | 'flow';
  paramValues?: Record<string, string>;
  outputVariable?: string;
}

/**
 * A step for a connector that is not set up yet is SKIPPED, not a failed
 * run. An agent can be designed with an email step before anyone has
 * signed in to Gmail or Outlook; until they do, the rest of the run still
 * does its work and the step says plainly why it did nothing. A tool that
 * fails on a connected account is still a failure.
 */
function skipped(nodeId: string, provider: string, toolName: string, reason: string) {
  logger.warn({ nodeId, provider, toolName, reason }, 'call_tool_skipped_not_connected');
  return {
    nodeId, nodeSubType: 'call_tool', success: true,
    output: { skipped: true, reason: `Skipped: ${reason}.`, toolName },
    toolsUsed: [`${provider}:${toolName}(skipped)`],
  };
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
    const urlRes = await pkgConn(ctx.conn).query<{ McpServerUrl__c?: string }>(
      `SELECT McpServerUrl__c FROM ConnectorCatalog__mdt WHERE DeveloperName = '${provider.replace(/'/g, "\\'")}' LIMIT 1`,
    );
    const override = await ServerOverrideRepo.get(ctx.orgId, provider).catch(() => null);
    const baseUrl = override?.mcpServerUrl ?? urlRes.records[0]?.McpServerUrl__c;
    if (!baseUrl) return skipped(node.id, provider, toolName, `the ${provider} connector has no server yet`);

    // WHOSE ACCOUNT. The agent's connector node for this provider says
    // whether an unattended run acts as the triggering user, and a person
    // who has not connected is a failed run with the reason — never a
    // silent switch to the shared account.
    const install = await InstallsRepo.findByOrgId(ctx.orgId);
    const catalogNode = ctx.agent.nodes.find(n => n.nodeType === 'catalog' && (n.config as { provider?: string })?.provider === provider);
    const orgPolicy = await OrgIdentityPolicyRepo.get(ctx.orgId);
    const policy = policyFor(identityInputFromConfig(catalogNode?.config ?? null), SALESFORCE_TOKEN_PROVIDERS.has(provider) ? ctx.agent.accessMode : null, orgPolicy, 'automation');
    const identity = await resolveIdentity({
      orgId: ctx.orgId, userId: ctx.userId, provider, policy, kind: 'automation',
      explicitConnectorId: config.connectorId, sfAccessToken: install?.sfAccessToken ?? null, orgPolicy,
    });
    if (!identity.ok) {
      if (identity.wanted === 'org') return skipped(node.id, provider, toolName, `the ${provider} connector is not connected yet — connect it on the Connectors page`);
      if (identity.wanted === 'connection') return skipped(node.id, provider, toolName, identity.message);
      logger.warn({ nodeId: node.id, provider, userId: ctx.userId, reason: identity.reason }, 'call_tool_no_identity_for_user');
      return {
        nodeId: node.id, nodeSubType: 'call_tool', success: false,
        error: `NEEDS_CONNECTION:${provider}:${ctx.userId} — No ${provider} identity for this user (runs as ${identity.wanted}, ${policy.fallback === 'org' ? 'org fallback failed' : 'no org fallback'}). ${identity.message}`,
      };
    }
    const token = identity.token;
    ctx.toolsUsed.add(`${provider}:${toolName}@${identity.principal.type}${identity.principal.subjectLabel ? `(${identity.principal.subjectLabel})` : ''}`);

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
