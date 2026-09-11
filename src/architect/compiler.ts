/**
 * The AgentSpec compiler — ordinary deterministic code. The model proposes
 * (an AgentSpec); this disposes (Archon package records). It writes ONLY
 * AgentDefinition__c / AgentNode__c rows and their CanvasJson wiring —
 * never client org metadata of any kind. There is no Metadata API, no
 * Tooling API and no deploy call anywhere in this module, by design.
 *
 * v1 surface (anything outside it is rejected with a precise error, never
 * silently narrowed):
 *   - conversational agents: trigger inbound_message | manual | webhook
 *   - node types: agent, subagent, tool (mcp / apex_invocable /
 *     flow_invocable / crud create·update·query), tool_catalog
 *   - crud compiles onto the Salesforce Platform MCP standard tools
 *   - approval compiles onto the write tool (approval.required →
 *     requiresApproval — enforced at runtime by approval-as-suspension)
 *
 * Invariants preserved from the platform:
 *   - every subagent/tool/catalog attachment uses fromPort 'tool' — the
 *     ONE port subagent-router.ts actually reads; anything else renders
 *     on the canvas but is invisible at runtime
 *   - lifecycle 'blocked' (or open blocking prerequisites) can never
 *     produce Status__c 'Active' — belt here, braces in assertActivatable
 */
import type { Connection } from 'jsforce';
import { logger } from '../logger';
import {
  validateSpec,
  assertActivatable,
  type AgentSpec,
  type SpecNode,
  type SpecPrerequisite,
  type CapabilityManifest,
} from './spec';

// ── Model tier resolution (same classification the UI pickers use) ───
const FAST_RE = /mini|nano|lite|flash|haiku|small/i;
const BEST_RE = /opus|ultra|(^|[^a-z])o[134]([^a-z]|$)|gpt-5|-pro($|[^a-z])/i;

function tierOfModel(id: string): 'small' | 'medium' | 'large' {
  if (FAST_RE.test(id)) return 'small';
  if (BEST_RE.test(id)) return 'large';
  return 'medium';
}

function providerOfModel(id: string): string {
  const m = id.toLowerCase();
  if (m.includes('claude') || m.includes('haiku') || m.includes('sonnet') || m.includes('opus')) return 'claude';
  if (m.includes('gemini')) return 'gemini';
  return 'gpt4';
}

interface OrgModels {
  /** All enabled model ids across active connections, deduped. */
  models: string[];
}

/** Same fallback the UI pickers use: an active connection with no curated
 *  catalog offers the provider's known default models. */
const ENGINE_DEFAULT_MODELS: Record<string, string[]> = {
  claude: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
};

async function loadOrgModels(conn: Connection): Promise<OrgModels> {
  const res = await conn.query<{
    EngineType__c: string;
    DefaultModel__c?: string;
    AvailableModelsJson__c?: string;
    IsPreferred__c?: boolean;
  }>(
    'SELECT EngineType__c, DefaultModel__c, AvailableModelsJson__c, IsPreferred__c ' +
      'FROM AiEngineConnection__c WHERE IsActive__c = true',
  );
  const models: string[] = [];
  for (const row of res.records) {
    if (row.DefaultModel__c) models.push(row.DefaultModel__c);
    let curated = 0;
    if (row.AvailableModelsJson__c) {
      try {
        const parsed = JSON.parse(row.AvailableModelsJson__c) as Array<string | { id?: string }>;
        for (const m of parsed) {
          const id = typeof m === 'string' ? m : m?.id;
          if (id) {
            models.push(id);
            curated++;
          }
        }
      } catch {
        /* malformed catalog JSON — fall through to the defaults below */
      }
    }
    if (curated === 0) {
      models.push(...(ENGINE_DEFAULT_MODELS[row.EngineType__c] ?? []));
    }
  }
  return { models: [...new Set(models)] };
}

/** tier → concrete model from what the org has actually enabled. An
 *  explicit modelId must exist in the org; a tier with no exact match
 *  falls to the nearest available with a compile note. */
function resolveModel(
  wanted: SpecNode['model'],
  org: OrgModels,
  notes: string[],
  nodeLabel: string,
): { modelId: string; provider: string } {
  if (org.models.length === 0) {
    throw new CompileError('No AI models are enabled in this org — connect a provider on the AI Models page first.');
  }
  if (wanted?.modelId) {
    if (!org.models.includes(wanted.modelId)) {
      throw new CompileError(
        `Node '${nodeLabel}' asks for model '${wanted.modelId}' but it is not enabled on any active connection.`,
      );
    }
    return { modelId: wanted.modelId, provider: providerOfModel(wanted.modelId) };
  }
  const tier = wanted?.tier ?? 'large';
  const byTier: Record<string, string[]> = { small: [], medium: [], large: [] };
  for (const m of org.models) byTier[tierOfModel(m)].push(m);

  const order: Record<string, Array<'small' | 'medium' | 'large'>> = {
    small: ['small', 'medium', 'large'],
    medium: ['medium', 'large', 'small'],
    large: ['large', 'medium', 'small'],
  };
  for (const t of order[tier]) {
    if (byTier[t].length > 0) {
      const pick = byTier[t][0];
      if (t !== tier) notes.push(`'${nodeLabel}': no ${tier}-tier model enabled — using ${pick} (${t} tier) instead.`);
      return { modelId: pick, provider: providerOfModel(pick) };
    }
  }
  throw new CompileError('No usable model found on any active connection.');
}

// ── crud → Salesforce Platform standard MCP tools ────────────────────
const CRUD_TOOL: Record<string, string> = {
  create: 'createSobjectRecord',
  update: 'updateSobjectRecord',
  query: 'soqlQuery',
};

export class CompileError extends Error {}

export interface CompileResult {
  agentId: string;
  apiName: string;
  status: string;
  nodeCount: number;
  blockedNodeIds: string[];
  notes: string[];
}

interface PlatformNode {
  specId: string | null;
  name: string;
  nodeType: string;
  nodeSubType: string;
  config: Record<string, unknown>;
  x: number;
  y: number;
  enabled: boolean;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'agent';
}

/**
 * Compile a validated spec into Archon records. `manifest` is the live
 * capability manifest — verification happens at compile time, not just at
 * design time, because orgs change between the two.
 */
export async function compileSpec(
  spec: AgentSpec,
  opts: { conn: Connection; orgId: string; manifest?: CapabilityManifest; existingAgentId?: string },
): Promise<CompileResult> {
  const errors = validateSpec(spec, opts.manifest);
  if (errors.length > 0) {
    throw new CompileError(
      'The spec does not validate:\n' + errors.map(e => `  ${e.path}: ${e.message}`).join('\n'),
    );
  }

  const notes: string[] = [];

  // v1 trigger surface.
  if (!['inbound_message', 'manual', 'webhook'].includes(spec.trigger.type)) {
    throw new CompileError(
      `Trigger '${spec.trigger.type}' is not compilable yet — v1 compiles conversational agents ` +
        '(inbound_message, manual, webhook). Record-change and scheduled agents compile in a later phase.',
    );
  }

  // v1 node surface.
  for (const n of spec.nodes) {
    if (['approval', 'condition', 'transform', 'end'].includes(n.type)) {
      throw new CompileError(
        n.type === 'approval'
          ? `Node '${n.id}': standalone approval nodes do not compile — set approval.required on the write tool instead; the runtime suspends those calls for a human decision.`
          : `Node '${n.id}': type '${n.type}' is not compilable in a conversational agent yet.`,
      );
    }
    if (n.type === 'subagent' && !(n.description && n.description.trim().length >= 10)) {
      // The routing description is the signal the lead model reads when
      // deciding to use the specialist — the compiler will not invent one.
      throw new CompileError(
        `Node '${n.id}': a sub-agent needs a description — one or two sentences on when the lead agent should use it.`,
      );
    }
    if (n.type === 'tool' && n.action) {
      if (n.action.kind === 'http' || n.action.kind === 'code') {
        throw new CompileError(`Node '${n.id}': action kind '${n.action.kind}' has no runtime executor yet.`);
      }
      if (n.action.kind === 'crud' && !CRUD_TOOL[n.action.operation ?? '']) {
        throw new CompileError(
          `Node '${n.id}': crud operation '${n.action.operation}' is not supported — ` +
            'create, update and query compile onto the Salesforce standard tools; delete is blocked for agents.',
        );
      }
    }
  }

  const root = spec.nodes.find(n => n.type === 'agent')!;
  const org = await loadOrgModels(opts.conn);

  // Blocked nodes: anything an open prerequisite says it affects.
  const blocked = new Set<string>();
  const prereqByNode = new Map<string, string>();
  for (const p of spec.prerequisites ?? []) {
    if (p.status === 'done' || p.status === 'waived') continue;
    for (const nodeId of p.affects ?? []) {
      blocked.add(nodeId);
      prereqByNode.set(nodeId, p.id);
    }
  }

  // Edge lookup: the inbound edge of each node carries its mode/policy.
  const inEdge = new Map<string, AgentSpec['edges'][number]>();
  for (const e of spec.edges) if (!inEdge.has(e.to)) inEdge.set(e.to, e);

  const customerChannel = ['whatsapp', 'sms', 'email', 'web'].includes(spec.trigger.channel ?? '');

  // ── Map nodes ──────────────────────────────────────────────────────
  const platformNodes: PlatformNode[] = [];
  const mcpToolNames: string[] = [];
  let hasSalesforceCatalog = false;

  for (const n of spec.nodes) {
    const pos = n.position ?? { x: 80 + platformNodes.length * 60, y: 80 + platformNodes.length * 90 };
    const isBlocked = blocked.has(n.id);
    const blockNote = isBlocked ? { blockedByPrerequisite: prereqByNode.get(n.id) } : {};

    if (n.type === 'agent') {
      const { modelId, provider } = resolveModel(n.model, org, notes, n.label);
      platformNodes.push({
        specId: n.id,
        name: n.label,
        nodeType: 'ai',
        nodeSubType: provider,
        config: {
          model: modelId,
          systemPrompt: n.instructions ?? '',
          answerStyle: n.model?.style ?? 'balanced',
          thinkingEffort: n.model?.effort ?? 'standard',
          maxReplyTokens: n.model?.maxOutputTokens,
          customerFacing: customerChannel,
          budgets: {
            maxSteps: spec.budgets.maxSteps,
            maxMs: Math.min(spec.budgets.timeoutSeconds * 1000, 110_000),
          },
          specNodeId: n.id,
        },
        x: pos.x,
        y: pos.y,
        enabled: true,
      });
    } else if (n.type === 'subagent') {
      const { modelId, provider } = resolveModel(n.model, org, notes, n.label);
      const edge = inEdge.get(n.id);
      let contextPolicy = edge?.contextPolicy ?? 'isolated';
      if (contextPolicy === 'summary') {
        contextPolicy = 'windowed';
        notes.push(`'${n.label}': context policy 'summary' maps to 'windowed' until the runtime grows a summary policy.`);
      }
      platformNodes.push({
        specId: n.id,
        name: n.label,
        nodeType: 'subagent',
        nodeSubType: provider,
        config: {
          routingDescription: n.description ?? '',
          systemPrompt: n.instructions ?? '',
          model: modelId,
          mode: edge?.mode === 'handoff' ? 'transfer' : 'call',
          contextPolicy,
          carryFields: edge?.carryFields,
          returns: n.returns,
          answerStyle: n.model?.style,
          thinkingEffort: n.model?.effort,
          maxReplyTokens: n.model?.maxOutputTokens,
          specNodeId: n.id,
          ...blockNote,
        },
        x: pos.x,
        y: pos.y,
        enabled: !isBlocked,
      });
    } else if (n.type === 'tool') {
      const a = n.action!;
      let actionType: string;
      let toolName: string;
      if (a.kind === 'mcp') {
        actionType = 'MCP';
        toolName = a.toolName ?? '';
        mcpToolNames.push(toolName);
      } else if (a.kind === 'apex_invocable') {
        actionType = 'Apex';
        toolName = a.toolName ?? '';
      } else if (a.kind === 'flow_invocable') {
        actionType = 'Flow';
        toolName = a.toolName ?? '';
      } else {
        actionType = 'MCP';
        toolName = CRUD_TOOL[a.operation!];
        mcpToolNames.push(toolName);
      }
      platformNodes.push({
        specId: n.id,
        name: n.label,
        nodeType: 'tool',
        nodeSubType: actionType.toLowerCase(),
        config: {
          description: n.description ?? '',
          actionType,
          toolName,
          connectorId: '',
          requiresApproval: n.approval?.required === true,
          approvalCondition: n.approval?.condition,
          parameterMappings: n.inputs,
          onFailure: n.onFailure,
          output: n.output,
          sobject: a.sobject,
          operation: a.operation,
          specNodeId: n.id,
          ...blockNote,
        },
        x: pos.x,
        y: pos.y,
        enabled: !isBlocked,
      });
      if (a.sideEffect && n.approval?.required !== true) {
        notes.push(`'${n.label}' writes data without an approval gate — the spec chose this explicitly.`);
      }
    } else if (n.type === 'tool_catalog') {
      const provider = (n.action?.connector ?? 'Salesforce Platform') === 'Salesforce Platform' ? 'salesforce_mcp' : n.action?.connector ?? '';
      if (provider === 'salesforce_mcp') hasSalesforceCatalog = true;
      platformNodes.push({
        specId: n.id,
        name: n.label,
        nodeType: 'catalog',
        nodeSubType: 'mcp',
        config: {
          description: n.description ?? '',
          provider,
          connectorId: '',
          allowedTools: [],
          specNodeId: n.id,
          ...blockNote,
        },
        x: pos.x,
        y: pos.y,
        enabled: !isBlocked,
      });
    }
  }

  // MCP/crud tools need the Salesforce Platform connector attached — the
  // runtime folds tool-node names into that connector's allowedTools, and
  // silently skips them when the connector is absent. Auto-inject the
  // catalog rather than shipping tools that can never fire.
  if (mcpToolNames.length > 0 && !hasSalesforceCatalog) {
    platformNodes.push({
      specId: null,
      name: 'Salesforce tools',
      nodeType: 'catalog',
      nodeSubType: 'mcp',
      config: {
        description: 'Salesforce Platform standard tools used by this agent.',
        provider: 'salesforce_mcp',
        connectorId: '',
        allowedTools: [...new Set(mcpToolNames)],
        autoInjected: true,
      },
      x: (root.position?.x ?? 400) + 280,
      y: (root.position?.y ?? 60) + 10,
      enabled: true,
    });
    notes.push('Added the Salesforce Platform tool catalog automatically — the MCP tools in this design need it to fire.');
  }

  // ── Wiring — fromPort 'tool' is the runtime's ONE attachment port ──
  const indexOfSpec = new Map<string, number>();
  platformNodes.forEach((p, i) => {
    if (p.specId) indexOfSpec.set(p.specId, i);
  });
  const connections: Array<{ fromIndex: number; toIndex: number; fromPort: string; toPort: string }> = [];
  for (const e of spec.edges) {
    const from = indexOfSpec.get(e.from);
    const to = indexOfSpec.get(e.to);
    if (from == null || to == null) continue; // node was not compiled (never silently: v1 rejects those above)
    connections.push({ fromIndex: from, toIndex: to, fromPort: 'tool', toPort: 'in' });
  }
  const injected = platformNodes.findIndex(p => p.specId === null);
  if (injected >= 0) {
    connections.push({ fromIndex: indexOfSpec.get(root.id)!, toIndex: injected, fromPort: 'tool', toPort: 'in' });
  }

  // ── Status mapping — the activation guard, applied twice ───────────
  const state = spec.lifecycle?.state ?? 'draft';
  let status = 'Draft';
  if (state === 'published') {
    assertActivatable(spec); // throws when blocked — braces to this belt
    status = 'Active';
  } else if (state === 'retired') {
    status = 'Inactive';
  }

  // Prerequisites → the agent's setup checklist (full detail preserved —
  // the UI reads title/description/category and tolerates the rest).
  const KIND_CATEGORY: Record<string, string> = {
    connector: 'connector',
    knowledge_base: 'knowledge_base',
  };
  const checklist = (spec.prerequisites ?? []).map((p: SpecPrerequisite) => ({
    title: p.title,
    description: `${p.why}\n${p.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
    category: KIND_CATEGORY[p.kind] ?? 'other',
    id: p.id,
    kind: p.kind,
    assignee: p.assignee,
    blocking: p.blocking,
    status: p.status,
    verification: p.verification,
    affects: p.affects,
    estimatedEffort: p.estimatedEffort,
  }));

  // ── Persist: Archon records ONLY ───────────────────────────────────
  const conn = opts.conn;
  const apiName = spec.requirementId && spec.requirementId.startsWith('agent_')
    ? spec.requirementId
    : slugify(spec.name);

  let agentId = opts.existingAgentId ?? null;
  if (!agentId) {
    const existing = await conn.query<{ Id: string }>(
      `SELECT Id FROM AgentDefinition__c WHERE ApiName__c = '${apiName.replace(/'/g, "\\'")}' LIMIT 1`,
    );
    agentId = existing.records[0]?.Id ?? null;
  }

  const defFields: Record<string, unknown> = {
    Name: spec.name,
    ApiName__c: apiName,
    Department__c: spec.department,
    Description__c: spec.description ?? '',
    Status__c: status,
    ExecuteType__c: 'Chat',
    CanvasJson__c: JSON.stringify({ connections, spec: { lifecycle: spec.lifecycle, architecture: spec.architecture, trigger: spec.trigger } }),
    SetupChecklistJson__c: JSON.stringify(checklist),
    Version__c: spec.lifecycle?.version ?? 1,
  };

  if (agentId) {
    await conn.sobject('AgentDefinition__c').update({ Id: agentId, ...defFields });
    const old = await conn.query<{ Id: string }>(`SELECT Id FROM AgentNode__c WHERE AgentDefinition__c = '${agentId}'`);
    if (old.records.length > 0) {
      await conn.sobject('AgentNode__c').destroy(old.records.map(r => r.Id));
    }
  } else {
    const created = await conn.sobject('AgentDefinition__c').insert(defFields);
    if (!created.success) throw new CompileError('Could not create the agent record.');
    agentId = created.id as string;
  }

  const nodeRows = platformNodes.map((p, i) => ({
    AgentDefinition__c: agentId!,
    Name: p.name.slice(0, 80),
    NodeType__c: p.nodeType,
    NodeSubType__c: p.nodeSubType,
    ConfigJson__c: JSON.stringify(p.config),
    PositionX__c: p.x,
    PositionY__c: p.y,
    SortOrder__c: i,
    IsEnabled__c: p.enabled,
  }));
  const inserted = await conn.sobject('AgentNode__c').insert(nodeRows);
  const failed = (Array.isArray(inserted) ? inserted : [inserted]).filter(r => !r.success);
  if (failed.length > 0) {
    throw new CompileError(`Could not create ${failed.length} node record(s).`);
  }

  logger.info(
    { orgId: opts.orgId, agentId, apiName, status, nodes: platformNodes.length, blocked: blocked.size, notes },
    'architect_spec_compiled',
  );

  return {
    agentId: agentId!,
    apiName,
    status,
    nodeCount: platformNodes.length,
    blockedNodeIds: [...blocked],
    notes,
  };
}
