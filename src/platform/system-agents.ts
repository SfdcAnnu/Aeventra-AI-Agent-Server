/**
 * System agents — agents the platform ships, defined as JSON on the server
 * and written into the SAME records every customer agent lives in
 * (AgentDefinition__c + AgentNode__c + the canvas wiring), so the ticket,
 * session, engine resolution and the chat runtime treat them like any
 * other agent. The JSON in git is the source of truth; the org rows are
 * the executable copy; sync makes them equal.
 *
 * The node shapes here are exactly what the Architect's compiler writes
 * (architect/compiler.ts), so the canvas renders them and the runtime
 * reads them without a special case. Tool nodes name their server through
 * connectorId; no catalog node is written — connections are derived from
 * the tool nodes (chat/tool-node-connectors.ts) and scoped per node.
 */
import type { Connection } from 'jsforce';
import { logger } from '../logger';
import { AgentCache } from '../chat/agent-cache';
import { modelForTier, resolveArchitectEngine, type ArchitectEngine } from '../architect/specialists';
import { forgetProviderUrls } from '../chat/tool-node-connectors';

export type Tier = 'small' | 'medium' | 'large';

export interface SystemToolSpec {
  /** Node name on the canvas. */
  name: string;
  /** Provider key of the MCP server (connector catalog DeveloperName, or archon_platform). */
  provider: string;
  toolName: string;
  description: string;
  requiresApproval?: boolean;
}

export interface SystemSubagentSpec {
  key: string;
  name: string;
  routingDescription: string;
  instructions: string;
  /** 'transfer' = Hands off; 'call' = Returns a value. */
  mode: 'transfer' | 'call';
  contextPolicy: 'isolated' | 'windowed' | 'full';
  tier: Tier;
  answerStyle?: 'precise' | 'balanced' | 'creative';
  thinkingEffort?: 'light' | 'standard' | 'deep';
  maxReplyTokens?: number;
  tools: SystemToolSpec[];
}

export interface SystemAgentSpec {
  apiName: string;
  name: string;
  version: number;
  /** true (default): the platform owns it — re-synced when the version
   *  changes, read-only on the canvas, cannot be deleted. false: seeded
   *  once, then the org's own agent to edit, wire and delete. */
  managed?: boolean;
  /** 'Org' (default) or 'PerUser'. */
  accessMode?: 'Org' | 'PerUser';
  department: string;
  description: string;
  root: {
    instructions: string;
    tier: Tier;
    answerStyle?: 'precise' | 'balanced' | 'creative';
    thinkingEffort?: 'light' | 'standard' | 'deep';
    maxReplyTokens?: number;
    parallelTools?: boolean;
    maxSteps?: number;
    tools: SystemToolSpec[];
  };
  subagents: SystemSubagentSpec[];
}

interface PlatformNode {
  name: string;
  nodeType: 'ai' | 'subagent' | 'tool';
  nodeSubType: string;
  config: Record<string, unknown>;
  x: number;
  y: number;
}

const COL_ROOT = 60, COL_CHILD = 400, COL_TOOL = 760, COL_TOOL_2 = 1000;
const ROW = 64, TOOL_ROW = 44;

/** Lay the spec out as canvas nodes plus the connections between them. */
export function layoutSystemAgent(spec: SystemAgentSpec, engine: ArchitectEngine): { nodes: PlatformNode[]; connections: Array<{ id: string; fromIndex: number; toIndex: number; fromPort: string; toPort: string }> } {
  const nodes: PlatformNode[] = [];
  const connections: Array<{ id: string; fromIndex: number; toIndex: number; fromPort: string; toPort: string }> = [];
  const connect = (from: number, to: number) => connections.push({ id: `e${from}:tool-${to}:in`, fromIndex: from, toIndex: to, fromPort: 'tool', toPort: 'in' });
  const toolNode = (t: SystemToolSpec, x: number, y: number): PlatformNode => ({
    name: t.name.slice(0, 80),
    nodeType: 'tool',
    nodeSubType: 'mcp',
    config: {
      description: t.description,
      actionType: 'MCP',
      toolName: t.toolName,
      connectorId: t.provider,
      requiresApproval: t.requiresApproval === true,
      system: true,
    },
    x, y,
  });

  const rootIndex = 0;
  nodes.push({
    name: spec.name,
    nodeType: 'ai',
    nodeSubType: engine.nodeSubType,
    config: {
      model: modelForTier(engine, spec.root.tier),
      systemPrompt: spec.root.instructions,
      answerStyle: spec.root.answerStyle ?? 'precise',
      thinkingEffort: spec.root.thinkingEffort ?? 'standard',
      maxReplyTokens: spec.root.maxReplyTokens,
      parallelTools: spec.root.parallelTools ?? false,
      customerFacing: false,
      budgets: { maxSteps: spec.root.maxSteps ?? 40, maxMs: 110_000 },
      system: true,
      specVersion: spec.version,
    },
    x: COL_ROOT, y: 60,
  });

  let y = 40;
  for (const t of spec.root.tools) {
    nodes.push(toolNode(t, COL_CHILD, y));
    connect(rootIndex, nodes.length - 1);
    y += TOOL_ROW;
  }
  y += 24;
  for (const s of spec.subagents) {
    const two = s.tools.length > 7;
    const rows = two ? Math.ceil(s.tools.length / 2) : s.tools.length;
    const blockH = Math.max(ROW, rows * TOOL_ROW);
    nodes.push({
      name: s.name,
      nodeType: 'subagent',
      nodeSubType: engine.nodeSubType,
      config: {
        routingDescription: s.routingDescription,
        systemPrompt: s.instructions,
        model: modelForTier(engine, s.tier),
        mode: s.mode,
        contextPolicy: s.contextPolicy,
        answerStyle: s.answerStyle ?? 'precise',
        thinkingEffort: s.thinkingEffort ?? 'standard',
        maxReplyTokens: s.maxReplyTokens,
        system: true,
        specKey: s.key,
      },
      x: COL_CHILD, y: y + Math.max(0, (blockH - ROW) / 2),
    });
    const subIndex = nodes.length - 1;
    connect(rootIndex, subIndex);
    s.tools.forEach((t, i) => {
      const col = two ? i % 2 : 0, row = two ? Math.floor(i / 2) : i;
      nodes.push(toolNode(t, col ? COL_TOOL_2 : COL_TOOL, y + row * TOOL_ROW));
      connect(subIndex, nodes.length - 1);
    });
    y += blockH + 40;
  }
  // Root sits at the vertical middle of everything it points to.
  nodes[rootIndex].y = Math.max(40, Math.round((nodes[1]?.y ?? 40) + (y - 40 - (nodes[1]?.y ?? 40)) / 2) - 60);
  return { nodes, connections };
}

export interface SyncResult {
  agentId: string;
  apiName: string;
  nodes: number;
  created: boolean;
  /** false when an org-owned (unmanaged) agent already existed and was left alone. */
  written: boolean;
  engine: string;
  model: string;
}

/** Whether this org's AgentDefinition__c has IsSystem__c yet — the field
 *  ships with the package; an org that has not deployed it still gets
 *  its agents. Cached per org for the life of the process. */
const isSystemFieldByOrg = new Map<string, Promise<boolean>>();
async function hasIsSystemField(conn: Connection): Promise<boolean> {
  const key = conn.instanceUrl ?? 'default';
  let p = isSystemFieldByOrg.get(key);
  if (!p) {
    p = conn.sobject('AgentDefinition__c').describe().then(d => d.fields.some(f => f.name === 'IsSystem__c')).catch(() => false);
    isSystemFieldByOrg.set(key, p);
  }
  return p;
}

/** Write (or rewrite) the spec's records in the org. Idempotent. A managed
 *  spec rewrites the nodes every time (the org's on/off status is kept);
 *  an unmanaged one is created once and never touched again. */
export async function syncSystemAgent(conn: Connection, orgId: string, spec: SystemAgentSpec): Promise<SyncResult> {
  const engine = await resolveArchitectEngine(conn);
  const { nodes, connections } = layoutSystemAgent(spec, engine);
  const managed = spec.managed !== false;
  const withSystemFlag = await hasIsSystemField(conn);

  const existing = await conn.query<{ Id: string }>(
    `SELECT Id FROM AgentDefinition__c WHERE ApiName__c = '${spec.apiName.replace(/'/g, "\\'")}' LIMIT 1`,
  );
  let agentId = existing.records[0]?.Id ?? null;
  if (agentId && !managed) {
    logger.info({ orgId, apiName: spec.apiName, agentId }, 'system_agent_left_to_org');
    return { agentId, apiName: spec.apiName, nodes: 0, created: false, written: false, engine: engine.engineType, model: modelForTier(engine, spec.root.tier) };
  }
  const defFields: Record<string, unknown> = {
    Name: spec.name,
    ApiName__c: spec.apiName,
    Department__c: spec.department,
    Description__c: managed ? `${spec.description}\n\n[built-in · v${spec.version} · managed by the platform]` : spec.description,
    ExecuteType__c: 'Chat',
    AccessMode__c: spec.accessMode ?? 'Org',
    // `system` in the canvas JSON is what marks the agent read-only for the
    // builder and the update tool; an org-owned seed carries no marker.
    CanvasJson__c: JSON.stringify(managed ? { connections, system: { apiName: spec.apiName, version: spec.version } } : { connections }),
    Version__c: spec.version,
    ...(withSystemFlag ? { IsSystem__c: managed } : {}),
  };
  let created = false;
  if (agentId) {
    await conn.sobject('AgentDefinition__c').update({ Id: agentId, ...defFields });
    const old = await conn.query<{ Id: string }>(`SELECT Id FROM AgentNode__c WHERE AgentDefinition__c = '${agentId}'`);
    if (old.records.length > 0) await conn.sobject('AgentNode__c').destroy(old.records.map(r => r.Id));
  } else {
    // Status is the org's switch: set once on create, never on re-sync.
    const ins = await conn.sobject('AgentDefinition__c').insert({ ...defFields, Status__c: 'Active' });
    if (!ins.success) throw new Error('Could not create the system agent record.');
    agentId = ins.id as string;
    created = true;
  }
  const rows = nodes.map((n, i) => ({
    AgentDefinition__c: agentId!,
    Name: n.name,
    NodeType__c: n.nodeType,
    NodeSubType__c: n.nodeSubType,
    ConfigJson__c: JSON.stringify(n.config),
    PositionX__c: n.x,
    PositionY__c: n.y,
    SortOrder__c: i,
    IsEnabled__c: true,
  }));
  const inserted = await conn.sobject('AgentNode__c').insert(rows);
  const failed = (Array.isArray(inserted) ? inserted : [inserted]).filter(r => !r.success);
  if (failed.length > 0) throw new Error(`Could not create ${failed.length} node record(s) for ${spec.apiName}.`);

  AgentCache.invalidate(orgId, spec.apiName);
  forgetProviderUrls();
  logger.info({ orgId, apiName: spec.apiName, agentId, nodes: nodes.length, created, engine: engine.engineType }, 'system_agent_synced');
  return { agentId: agentId!, apiName: spec.apiName, nodes: nodes.length, created, written: true, engine: engine.engineType, model: modelForTier(engine, spec.root.tier) };
}
