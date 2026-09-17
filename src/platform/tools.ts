/**
 * Platform tools — the Archon server's own functions served as MCP tools,
 * so an agent on the canvas wires them like any other tool node (provider
 * key `archon_platform`). Every handler runs as the principal the turn's
 * token carries: that org, that user, that session.
 *
 * Milestone 1 ships the registry and the two lookups every desk needs;
 * the build, plan and dashboard tools land with their milestones.
 */
import { z } from 'zod';
import { AgentCache } from '../chat/agent-cache';
import { getOrgConnection } from '../salesforce/per-org-connection';
import type { PlatformPrincipal } from './token';

export interface PlatformToolResult {
  text: string;
  structured?: Record<string, unknown>;
  isError?: boolean;
}

export interface PlatformTool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  readOnly: boolean;
  handler: (args: z.infer<z.ZodObject<Shape>>, principal: PlatformPrincipal) => Promise<PlatformToolResult>;
}

function define<Shape extends z.ZodRawShape>(t: PlatformTool<Shape>): PlatformTool<z.ZodRawShape> {
  return t as unknown as PlatformTool<z.ZodRawShape>;
}

const ok = (structured: Record<string, unknown>, text?: string): PlatformToolResult => ({
  text: text ?? JSON.stringify(structured, null, 2),
  structured,
});
const fail = (message: string): PlatformToolResult => ({ text: `Error: ${message}`, structured: { error: message }, isError: true });

const listAgents = define({
  name: 'list_agents',
  title: 'List agents',
  description:
    'The agents on this platform for the caller\'s org: name, API name, status (Active, Draft, Inactive), department. ' +
    'Filter by a name fragment or a status. System agents (the copilot itself) are left out.',
  inputSchema: {
    nameLike: z.string().max(80).optional().describe('Only agents whose name or API name contains this'),
    status: z.enum(['Active', 'Draft', 'Inactive']).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  },
  readOnly: true,
  handler: async ({ nameLike, status, limit }, p) => {
    const conn = await getOrgConnection(p.orgId);
    const where: string[] = [];
    if (status) where.push(`Status__c = '${status}'`);
    if (nameLike) {
      const q = nameLike.replace(/'/g, "\\'");
      where.push(`(Name LIKE '%${q}%' OR ApiName__c LIKE '%${q}%')`);
    }
    const soql =
      'SELECT Id, Name, ApiName__c, Status__c, Department__c, LastModifiedDate FROM AgentDefinition__c' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY Status__c, Name LIMIT ${limit}`;
    const res = await conn.query<{ Id: string; Name: string; ApiName__c: string; Status__c: string; Department__c?: string; LastModifiedDate: string }>(soql);
    const agents = res.records
      .filter(r => r.ApiName__c !== 'archon_copilot')
      .map(r => ({ name: r.Name, apiName: r.ApiName__c, status: r.Status__c, department: r.Department__c ?? null, lastModified: r.LastModifiedDate }));
    return ok({ count: agents.length, agents });
  },
});

const agentDetails = define({
  name: 'agent_details',
  title: 'Agent details',
  description:
    'One agent\'s definition as the canvas holds it: the root node, its sub-agents, tools and catalogs, each with its id ' +
    '(needed for a config change proposal), name, kind, and the settings that matter (model, mode, routing, approval).',
  inputSchema: { apiName: z.string().min(1).max(120).describe('The agent API name from list_agents') },
  readOnly: true,
  handler: async ({ apiName }, p) => {
    const conn = await getOrgConnection(p.orgId);
    const agent = await AgentCache.load(p.orgId, apiName, conn);
    if (!agent) return fail(`No agent with API name ${apiName} — call list_agents first.`);
    const nodes = agent.nodes.map(n => {
      const cfg = (n.config ?? {}) as Record<string, unknown>;
      const keep: Record<string, unknown> = {};
      for (const k of ['model', 'mode', 'contextPolicy', 'routingDescription', 'description', 'actionType', 'toolName', 'connectorId', 'requiresApproval', 'answerStyle', 'thinkingEffort', 'provider', 'allowedTools']) {
        if (cfg[k] !== undefined && cfg[k] !== '' && cfg[k] !== null) keep[k] = cfg[k];
      }
      const instructions = typeof cfg.systemPrompt === 'string' ? cfg.systemPrompt : null;
      return {
        id: n.id, name: n.name, kind: n.nodeType, subType: n.nodeSubType, enabled: n.isEnabled,
        settings: keep,
        instructions: instructions ? (instructions.length > 1200 ? `${instructions.slice(0, 1200)} …` : instructions) : undefined,
      };
    });
    const connections = (agent.canvasJson?.connections ?? []).map(c => ({ from: agent.nodes[c.fromIndex]?.id ?? null, to: agent.nodes[c.toIndex]?.id ?? null }));
    return ok({ name: agent.name, apiName: agent.apiName, status: agent.status, department: agent.department ?? null, accessMode: agent.accessMode ?? 'Org', nodes, connections });
  },
});

export const PLATFORM_TOOLS: PlatformTool[] = [listAgents, agentDetails];

export function platformToolCatalogue(): Array<{ name: string; title: string; description: string; readOnly: boolean }> {
  return PLATFORM_TOOLS.map(t => ({ name: t.name, title: t.title, description: t.description, readOnly: t.readOnly }));
}
