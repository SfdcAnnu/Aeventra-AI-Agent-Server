/**
 * Phase 7 — executes a chat-mode ChatApproval row once a human approves it.
 * Re-resolves the tool exactly as a live turn would (same connector
 * resolution, same MCP loading, same prebuilt builder — with NO approval
 * gate applied, since approval is what this IS), finds the suspended tool
 * by name across the root scope and every subagent scope, and invokes it
 * with the stored arguments. The MCP wrapper's pre-flight checks and
 * call logging still apply — an approved call is a normal call, just
 * human-paced.
 */
import type { ChatApproval } from '@prisma/client';
import { logger } from '../logger';
import { AgentCache } from './agent-cache';
import { InstallsRepo } from '../db/installs.repo';
import { getOrgConnection } from '../salesforce/per-org-connection';
import { buildGraph } from '../orchestrator/graph';
import {
  resolveTopLevelToolsAndSubagents,
  resolveSubagentActions,
  toSyntheticAiNode,
} from './subagent-router';
import { resolveMcpServers } from './adapters/shared';
import { buildConnectorInputsFromAgent } from './adapters/connectors-from-agent';
import { loadMcpTools } from '../lc/mcp-tools';
import { buildPrebuiltTools } from '../lc/prebuilt-tools';
import { mergeActionsIntoConnectors } from '../lc/graph-runtime';
import type { ChatTurnRequest } from './adapters/types';

export async function executeApprovedAction(approval: ChatApproval): Promise<string> {
  const orgId = approval.orgId;
  const conn = await getOrgConnection(orgId);
  const agent = await AgentCache.load(orgId, approval.agentApiName, conn);
  if (!agent) throw new Error(`Agent ${approval.agentApiName} no longer exists.`);
  const install = await InstallsRepo.findByOrgId(orgId);
  if (!install?.sfAccessToken) throw new Error('Org has no Salesforce tokens.');
  const aiNode = agent.nodes.find(n => n.nodeType === 'ai');
  if (!aiNode) throw new Error('Agent has no AI orchestrator node.');

  const graph = buildGraph(agent);
  const baseConnectors = await buildConnectorInputsFromAgent(agent, aiNode, conn);
  const reqLike: ChatTurnRequest = {
    agent,
    sessionId: approval.sessionId,
    history: [],
    newUserMessage: '',
    connectors: baseConnectors,
    context: {
      orgId,
      userId: approval.userId,
      recordContextId: approval.recordContextId ?? null,
      recordContextType: approval.recordContextType ?? null,
    },
  };
  const turnCtx = {
    orgId,
    recordContextId: approval.recordContextId ?? null,
    recordContextType: approval.recordContextType ?? null,
  };

  const { topLevelActions } = resolveTopLevelToolsAndSubagents(agent, graph, aiNode);
  const scopes = [
    { owner: aiNode, node: aiNode, actions: topLevelActions },
    ...agent.nodes
      .filter(n => n.nodeType === 'subagent' && n.isEnabled)
      .map(s => ({ owner: s, node: toSyntheticAiNode(s, aiNode), actions: resolveSubagentActions(graph, s) })),
  ];

  for (const scope of scopes) {
    // Prebuilt tools are local — cheap to build and check first.
    const local = buildPrebuiltTools(turnCtx, graph, scope.owner).find(t => t.name === approval.toolName);
    if (local) {
      logger.info({ orgId, approvalId: approval.id, tool: approval.toolName, scope: scope.owner.name }, 'chat_approval_executing');
      const out = await local.invoke((approval.argsJson ?? {}) as never);
      return typeof out === 'string' ? out : JSON.stringify(out);
    }

    const connectors = mergeActionsIntoConnectors(baseConnectors, scope.actions.filter(a => a.actionType !== 'Prebuilt'));
    const servers = await resolveMcpServers({ ...reqLike, connectors }, scope.node, install.sfAccessToken);
    const loaded = await loadMcpTools(servers);
    const t = loaded.tools.find(x => x.name === approval.toolName);
    if (t) {
      logger.info({ orgId, approvalId: approval.id, tool: approval.toolName, scope: scope.owner.name }, 'chat_approval_executing');
      const out = await t.invoke((approval.argsJson ?? {}) as never);
      return typeof out === 'string' ? out : JSON.stringify(out);
    }
  }
  throw new Error(`Tool ${approval.toolName} is no longer connected to this agent — nothing was executed.`);
}
