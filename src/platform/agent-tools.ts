/**
 * Tools that act on agents: hand a conversation to another agent, and edit
 * an existing agent's canvas. Both are platform mechanics, not use-case
 * logic — which agent, which node, which value all come from the caller.
 */
import { z } from 'zod';
import { AgentCache } from '../chat/agent-cache';
import { getOrgConnection } from '../salesforce/per-org-connection';
import { pkgConn } from '../salesforce/namespace';
import { logger } from '../logger';
import { ChatApprovalsRepo } from '../db/chat-approvals.repo';
import { define, ok, fail, clip } from './tool-kit';
import { homeStats } from './inspector-tools';

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

/**
 * A view on the screen is a RESULT the client acts on, like a transfer:
 * the model decides a view answers better than words, and the Archon
 * screen draws it beside the conversation. The result carries the rows
 * the view will show — usage and cost per agent, today's failed runs,
 * the drafts, what is waiting for approval — in the shapes the screen
 * already draws, so the screen and the words come from the same data and
 * the person never sees a table that disagrees with the reply. The
 * dashboard is the Home numbers; the screen reads those itself.
 */
export const SCREEN_VIEWS = ['dashboard', 'usage', 'failures', 'drafts', 'approvals', 'cost', 'build'] as const;
export type ScreenView = (typeof SCREEN_VIEWS)[number];

export interface UsageRow { apiName: string; name: string; turns: number; tokensIn: number; tokensOut: number }
export interface UsageStats { days: number; byAgent: Array<{ apiName: string | null; name: string | null; turns: number; tokensIn: number; tokensOut: number }> }

export function screenPayload(view: ScreenView, days: number | undefined, agentApiName: string | undefined, stats: UsageStats | null) {
  const screen = { view, days: days ?? null, agentApiName: agentApiName ?? null };
  if (!stats) return { screen };
  const rows: UsageRow[] = stats.byAgent
    .filter((r): r is UsageStats['byAgent'][number] & { apiName: string } => !!r.apiName)
    .filter(r => !agentApiName || r.apiName === agentApiName)
    .map(r => ({ apiName: r.apiName, name: r.name ?? r.apiName, turns: r.turns, tokensIn: r.tokensIn, tokensOut: r.tokensOut }))
    .sort((a, b) => (b.tokensIn + b.tokensOut) - (a.tokensIn + a.tokensOut));
  return {
    screen,
    usage: {
      days: stats.days,
      turns: rows.reduce((s, r) => s + r.turns, 0),
      tokensIn: rows.reduce((s, r) => s + r.tokensIn, 0),
      tokensOut: rows.reduce((s, r) => s + r.tokensOut, 0),
      byAgent: rows,
    },
  };
}

const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const FAILED_STATUSES = ['ERROR', 'TIMEOUT', 'FAILED'];

/** Today's failed runs, in the row shape the Runs page and the screen
 *  already draw (flat keys, as Apex returns them). Capped: the rows reach
 *  the model too, and thirty failures is already a list to act on. */
async function failedRunsToday(conn: ReturnType<typeof pkgConn>): Promise<Array<Record<string, unknown>>> {
  const r = await conn.query<Record<string, unknown>>(
    'SELECT Id, Name, AgentDefinition__r.Name, AgentDefinition__r.Department__c, RecordId__c, Status__c, AgentReason__c, ExecutionMs__c, CreatedDate ' +
      `FROM AgentExecution__c WHERE CreatedDate = TODAY AND Status__c IN (${FAILED_STATUSES.map(s => `'${s}'`).join(',')}) ORDER BY CreatedDate DESC LIMIT 30`,
  );
  return r.records.map(x => {
    const def = (x.AgentDefinition__r as { Name?: string; Department__c?: string } | null) ?? {};
    return {
      Id: x.Id, Name: x.Name,
      'AgentDefinition__r.Name': def.Name ?? '', 'AgentDefinition__r.Department__c': def.Department__c ?? '',
      CorrelationId__c: null, RecordId__c: x.RecordId__c ?? null, Status__c: x.Status__c,
      AgentScore__c: null, AgentPriority__c: null, AgentReason__c: clip(x.AgentReason__c as string | null, 200),
      ToolsUsed__c: null, OutputPayload__c: null, ExecutionMs__c: x.ExecutionMs__c ?? null, Department__c: null, CreatedDate: x.CreatedDate,
    };
  });
}

/** Agents still in Draft, in the agent-list shape. */
async function draftAgents(conn: ReturnType<typeof pkgConn>): Promise<Array<Record<string, unknown>>> {
  const r = await conn.query<Record<string, unknown>>(
    'SELECT Id, Name, ApiName__c, Department__c, Description__c, Status__c, Version__c, ExecuteType__c, CreatedDate, LastModifiedDate ' +
      "FROM AgentDefinition__c WHERE Status__c = 'Draft' ORDER BY LastModifiedDate DESC LIMIT 50",
  );
  return r.records
    .filter(x => x.ApiName__c !== 'archon_copilot')
    .map(x => ({
      id: x.Id, name: x.Name, apiName: x.ApiName__c, department: x.Department__c ?? '', description: clip(x.Description__c as string | null, 200) ?? '',
      status: x.Status__c, version: x.Version__c ?? null, totalExecutions: null, successRate: null, isSystem: false,
      executeType: x.ExecuteType__c ?? 'Chat', streamReplies: false, createdDate: x.CreatedDate, lastModifiedDate: x.LastModifiedDate,
    }));
}

/** What is waiting for a decision: chat actions the runtime suspended (this
 *  server's own store) and run approvals (the org), each in the shape the
 *  Approvals page draws, so the screen can decide them in place. */
async function pendingApprovals(conn: ReturnType<typeof pkgConn>, orgId: string): Promise<{ approvals: Array<Record<string, unknown>>; chatApprovals: Array<Record<string, unknown>> }> {
  const chat = await ChatApprovalsRepo.listForOrg(orgId, { status: 'Pending', limit: 30 }).catch(() => []);
  let approvals: Array<Record<string, unknown>> = [];
  try {
    const r = await conn.query<Record<string, unknown>>(
      "SELECT Id, Name, AgentApiName__c, NodeLabel__c, RecordId__c, Status__c, CreatedDate, TimeoutAt__c FROM AgentApproval__c WHERE Status__c = 'Pending' ORDER BY CreatedDate ASC LIMIT 30",
    );
    approvals = r.records.map(x => ({
      id: x.Id, name: x.Name, agentApiName: x.AgentApiName__c ?? '', nodeLabel: x.NodeLabel__c ?? '', recordId: x.RecordId__c ?? null,
      status: x.Status__c, createdDate: x.CreatedDate, timeoutAt: x.TimeoutAt__c ?? null,
    }));
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'show_on_screen: run approvals unavailable');
  }
  return {
    approvals,
    chatApprovals: (chat as Array<Record<string, unknown>>).map(a => ({
      id: a.id, agentApiName: a.agentApiName, sessionId: a.sessionId, userId: a.userId, toolName: a.toolName, argsJson: a.argsJson,
      status: a.status, timeoutAt: a.timeoutAt, createdAt: a.createdAt,
    })),
  };
}

const showOnScreen = define({
  name: 'show_on_screen',
  title: 'Show on the screen',
  description:
    'Put a view on the screen beside this conversation, when a view answers better than words. The views: ' +
    'dashboard (today: runs, chat turns, approvals waiting, spend, runs by hour, what happened), ' +
    'usage (turns, tokens and spend per agent over the last N days — the report of who used what), ' +
    'failures (runs that failed today), drafts (agents not yet active), approvals (waiting for a decision), ' +
    'cost (spend per agent over the last N days as a chart), build (the Architect\'s current build). ' +
    'The result carries the rows the view shows — quote those figures in your words. ' +
    'Do not open a view for a greeting, a question about what you can do, or anything a sentence answers. The screen changes on its own.',
  inputSchema: {
    view: z.enum(SCREEN_VIEWS).describe('Which view to show.'),
    days: z.number().int().min(1).max(31).optional().describe('For usage and cost: how many days back — today = 1, this week = 7, this month = 31. Default 31.'),
    agentApiName: z.string().max(120).optional().describe('Narrow usage or cost to one agent, when the person named one.'),
  },
  readOnly: true,
  handler: async ({ view, days, agentApiName }, p) => {
    let stats: UsageStats | null = null;
    let rows: Record<string, unknown> = {};
    try {
      const raw = await getOrgConnection(p.orgId);
      if (view === 'usage' || view === 'cost') stats = await homeStats(raw, days ?? 31);
      else if (view === 'failures') rows = { runs: await failedRunsToday(pkgConn(raw)) };
      else if (view === 'drafts') rows = { agents: await draftAgents(pkgConn(raw)) };
      else if (view === 'approvals') rows = await pendingApprovals(pkgConn(raw), p.orgId);
    } catch (err) {
      // The screen can still draw the view from the org itself; only the
      // rows travelling with the words are lost.
      logger.warn({ err, view }, 'show_on_screen: could not read the rows for the view');
    }
    const payload = { ...screenPayload(view, days ?? (stats ? stats.days : undefined), agentApiName, stats), ...rows };
    const count = Array.isArray(rows.runs) ? `${rows.runs.length} failed run(s) today` : Array.isArray(rows.agents) ? `${rows.agents.length} draft(s)` : Array.isArray(rows.approvals) ? `${(rows.approvals as unknown[]).length + ((rows.chatApprovals as unknown[] | undefined)?.length ?? 0)} waiting` : null;
    return ok(
      payload,
      `${JSON.stringify(payload)}\nSHOWN: the ${view} view is on the screen beside this conversation now and the person can see it${count ? ` (${count})` : ''}. ` +
        'Describe what it shows in a sentence or two with the key figures from the rows above. Never say you cannot display or visualise it.',
    );
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
    const res = await pkgConn(conn).sobject('AgentNode__c').update(updates);
    const failed = (Array.isArray(res) ? res : [res]).filter(r => !r.success);
    if (failed.length) return fail(`${failed.length} node update(s) failed: ${JSON.stringify(failed[0])}`);
    AgentCache.invalidate(p.orgId, apiName);
    logger.info({ orgId: p.orgId, apiName, applied: applied.length, by: p.userId }, 'agent_updated_by_tool');
    return ok({ apiName, applied, skipped });
  },
});

/**
 * Give an existing agent a tool it did not have.
 *
 * update_agent can only change what a node already says. Everything
 * structural — giving an agent a capability it was built without — meant
 * rebuilding the whole agent from its requirement, which is a strange
 * price for "it also needs to be able to look up the account".
 *
 * A tool node is a row plus a wire. The row carries which tool on which
 * server; the wire is a connection in the agent's canvas from the root's
 * TOOL port, which is the only port the router reads (platform rule 3).
 * Connections are INDEX-based — position in the node list, ordered by
 * SortOrder — so the new node is appended and wired at its own index.
 * Getting that wrong leaves a node that renders on the canvas and is
 * invisible at runtime, which looks like the tool being ignored.
 */
const addAgentTool = define({
  name: 'add_agent_tool',
  title: 'Add a tool to an agent',
  description:
    'Give an existing agent a tool it does not have yet: an MCP tool from a connected server, or a standard Salesforce create/update/query. ' +
    'Names the tool, what it is for, and whether using it needs a person\'s approval. Built-in agents are read-only. Waits for a person\'s approval.',
  inputSchema: {
    apiName: z.string().min(1).max(120).describe('API name of the agent to give the tool to.'),
    label: z.string().min(1).max(80).describe('What this tool is called on the canvas, in plain words.'),
    toolName: z.string().min(1).max(120).describe('The tool exactly as the server publishes it, e.g. soqlQuery or createSobjectRecord.'),
    provider: z.string().min(1).max(80).default('salesforce_mcp').describe('Which connected server publishes it. Defaults to the Salesforce Platform server.'),
    description: z.string().min(1).max(600).describe('One or two sentences about WHEN to use it — this is the routing signal the model reads.'),
    requiresApproval: z.boolean().default(false).describe('True if a person must approve each use before it runs.'),
    sobject: z.string().max(80).optional().describe('For a create/update/query, the object it acts on.'),
  },
  readOnly: false,
  handler: async (args, p) => {
    const { apiName, label, toolName, provider, description, requiresApproval, sobject } = args;
    const conn = await getOrgConnection(p.orgId);
    const agent = await AgentCache.load(p.orgId, apiName, conn);
    if (!agent) return fail(`No agent with API name ${apiName}.`);
    if ((agent.canvasJson as { system?: unknown } | undefined)?.system) {
      return fail(`${agent.name} is a built-in agent managed by the platform — it can be switched on or off, not edited.`);
    }
    if (agent.nodes.some(n => n.nodeType === 'tool' && (n.config as { toolName?: string } | undefined)?.toolName === toolName)) {
      return fail(`${agent.name} already has a tool for ${toolName}.`);
    }
    const root = agent.nodes.find(n => n.nodeType === 'ai');
    if (!root) return fail(`${agent.name} has no root agent node to attach a tool to.`);

    // Index-based wiring: the canvas orders nodes by SortOrder, so the new
    // node's index is the current count and the root's is its position now.
    const ordered = [...agent.nodes].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    const rootIndex = ordered.findIndex(n => n.id === root.id);
    const newIndex = ordered.length;

    const created = await pkgConn(conn).sobject('AgentNode__c').insert({
      AgentDefinition__c: agent.id,
      Name: label.slice(0, 80),
      NodeType__c: 'tool',
      NodeSubType__c: 'mcp',
      ConfigJson__c: JSON.stringify({
        description,
        actionType: 'MCP',
        toolName,
        // THE RUNTIME ROUTES ON connectorId, NOT on a `provider` key:
        // providerOfAction reads connectorId and falls back to the
        // Salesforce Platform server when it is blank. Writing the
        // provider anywhere else sends every tool to Salesforce however
        // the caller named the server.
        connectorId: provider,
        provider,
        requiresApproval: requiresApproval === true,
        ...(sobject ? { sobject } : {}),
        addedBy: 'add_agent_tool',
      }),
      PositionX__c: 320,
      PositionY__c: 140 + newIndex * 90,
      SortOrder__c: newIndex,
      IsEnabled__c: true,
    });
    if (!created.success) return fail(`Could not add the tool node: ${JSON.stringify(created)}`);

    const canvas = (agent.canvasJson ?? {}) as { connections?: unknown[] };
    const connections = Array.isArray(canvas.connections) ? [...canvas.connections] : [];
    connections.push({
      id: `e${rootIndex}:tool-${newIndex}:in`,
      fromIndex: rootIndex,
      toIndex: newIndex,
      fromPort: 'tool',
      toPort: 'in',
    });
    await pkgConn(conn).sobject('AgentDefinition__c').update({
      Id: agent.id,
      CanvasJson__c: JSON.stringify({ ...canvas, connections }),
    });

    AgentCache.invalidate(p.orgId, apiName);
    logger.info({ orgId: p.orgId, apiName, toolName, provider, by: p.userId }, 'agent_tool_added');
    return ok({
      apiName,
      added: { label, toolName, provider, requiresApproval: requiresApproval === true },
      wiredFrom: root.name,
      note: 'The agent can use it on its next turn. Its instructions were not changed — say so if the agent also needs telling when to use it.',
    });
  },
});

export const AGENT_TOOLS = [transferToAgent, showOnScreen, updateAgent, addAgentTool];
