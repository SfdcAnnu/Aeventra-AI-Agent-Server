/**
 * Tools that act on agents: hand a conversation to another agent, and edit
 * an existing agent's canvas. Both are platform mechanics, not use-case
 * logic — which agent, which node, which value all come from the caller.
 */
import { z } from 'zod';
import { AgentCache } from '../chat/agent-cache';
import { getOrgConnection } from '../salesforce/per-org-connection';
import { logger } from '../logger';
import { define, ok, fail } from './tool-kit';

/**
 * A transfer is a RESULT the client acts on, not something the server does:
 * the tool returns `{ transfer: {…} }` and the chat UI switches the
 * session to that agent, carrying the message. Text-only clients simply
 * see which agent to talk to.
 */
const transferToAgent = define({
  name: 'transfer_to_agent',
  title: 'Transfer to another agent',
  description: 'Hand this conversation to another active agent in the org — for work that agent owns (for example metadata changes). Returns the agent to switch to and the message to carry over; the chat moves there.',
  inputSchema: {
    agentApiName: z.string().min(1).max(120).describe('API name of the agent to transfer to (see list_agents).'),
    message: z.string().min(1).max(4000).describe('What the person asked, restated for the receiving agent.'),
  },
  readOnly: true,
  handler: async ({ agentApiName, message }, p) => {
    const conn = await getOrgConnection(p.orgId);
    const agent = await AgentCache.load(p.orgId, agentApiName, conn);
    if (!agent) return fail(`No agent with API name ${agentApiName} — call list_agents first.`);
    if (agent.status !== 'Active') return fail(`${agent.name} is ${agent.status}, not Active — it cannot take a conversation.`);
    return ok({ transfer: { agentApiName: agent.apiName, agentName: agent.name, message } }, `TRANSFER to ${agent.name} (${agent.apiName}): ${message}`);
  },
});

const OP_TO_KEY: Record<string, string> = {
  setInstructions: 'systemPrompt',
  setDescription: 'description',
  setRoutingDescription: 'routingDescription',
  setModel: 'model',
  setApproval: 'requiresApproval',
  setContextPolicy: 'contextPolicy',
  setMode: 'mode',
};

const updateAgent = define({
  name: 'update_agent',
  title: 'Update an agent',
  description: 'Apply edits to an existing agent\'s nodes: instructions, description, routing description, model, approval flag, context policy, mode. Each operation names a node id from agent_details. Built-in agents are read-only. Waits for a person\'s approval.',
  inputSchema: {
    apiName: z.string().min(1).max(120),
    operations: z.array(z.object({
      kind: z.enum(['setInstructions', 'setDescription', 'setRoutingDescription', 'setModel', 'setApproval', 'setContextPolicy', 'setMode']),
      nodeId: z.string().min(1),
      value: z.union([z.string().max(20_000), z.boolean()]),
      why: z.string().max(400).optional(),
    })).min(1).max(20),
  },
  readOnly: false,
  handler: async ({ apiName, operations }, p) => {
    const conn = await getOrgConnection(p.orgId);
    const agent = await AgentCache.load(p.orgId, apiName, conn);
    if (!agent) return fail(`No agent with API name ${apiName}.`);
    if ((agent.canvasJson as { system?: unknown } | undefined)?.system) return fail(`${agent.name} is a built-in agent managed by the platform — it can be switched on or off, not edited.`);
    const byId = new Map(agent.nodes.map(n => [n.id, n]));
    const updates: Array<{ Id: string; ConfigJson__c: string }> = [];
    const applied: Array<{ nodeId: string; node: string; kind: string }> = [];
    const skipped: string[] = [];
    for (const op of operations) {
      const node = byId.get(op.nodeId);
      if (!node) { skipped.push(`${op.nodeId}: no such node`); continue; }
      if (op.kind === 'setApproval' && typeof op.value !== 'boolean') { skipped.push(`${op.nodeId}: setApproval needs true/false`); continue; }
      if (op.kind !== 'setApproval' && typeof op.value !== 'string') { skipped.push(`${op.nodeId}: ${op.kind} needs text`); continue; }
      if (op.kind === 'setContextPolicy' && !['isolated', 'windowed', 'full'].includes(String(op.value))) { skipped.push(`${op.nodeId}: contextPolicy must be isolated, windowed or full`); continue; }
      if (op.kind === 'setMode' && !['call', 'transfer'].includes(String(op.value))) { skipped.push(`${op.nodeId}: mode must be call or transfer`); continue; }
      node.config = { ...node.config, [OP_TO_KEY[op.kind]]: op.value };
      const existing = updates.find(u => u.Id === node.id);
      const json = JSON.stringify(node.config);
      if (existing) existing.ConfigJson__c = json; else updates.push({ Id: node.id, ConfigJson__c: json });
      applied.push({ nodeId: node.id, node: node.name, kind: op.kind });
    }
    if (updates.length === 0) return fail(`Nothing applied: ${skipped.join('; ')}`);
    const res = await conn.sobject('AgentNode__c').update(updates);
    const failed = (Array.isArray(res) ? res : [res]).filter(r => !r.success);
    if (failed.length) return fail(`${failed.length} node update(s) failed: ${JSON.stringify(failed[0])}`);
    AgentCache.invalidate(p.orgId, apiName);
    logger.info({ orgId: p.orgId, apiName, applied: applied.length, by: p.userId }, 'agent_updated_by_tool');
    return ok({ apiName, applied, skipped });
  },
});

export const AGENT_TOOLS = [transferToAgent, updateAgent];
