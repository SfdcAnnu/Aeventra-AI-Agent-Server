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
 *   - automation agents: `flow` compiles into logic/action nodes after the
 *     trigger, wired on the engine's own ports (see flow.ts)
 *
 * Invariants preserved from the platform:
 *   - every subagent/tool/catalog attachment uses fromPort 'tool' — the
 *     ONE port subagent-router.ts actually reads; anything else renders
 *     on the canvas but is invisible at runtime
 *   - lifecycle 'blocked' (or open blocking prerequisites) can never
 *     produce Status__c 'Active' — belt here, braces in assertActivatable
 */
import type { Connection } from 'jsforce';
import { pkgConn } from '../salesforce/namespace';
import { fitToLengths } from './org-facts';
import { withRunRules } from './run-rules';
import { logger } from '../logger';
import {
  validateSpec,
  assertActivatable,
  type AgentSpec,
  type SpecNode,
  type SpecPrerequisite,
  type CapabilityManifest,
} from './spec';
import { compileFlow } from './flow';

/** What every AI step in an automation is told, whatever its task. */
export const AI_STEP_SYSTEM_PROMPT =
  'You are one step in an unattended Salesforce automation. Do exactly the task in the message, using only the data it gives you. ' +
  'Never ask a question, never add commentary, and never invent a fact that is not in the data — when the data does not say, pick the answer ' +
  'the task defines for that case, or the most cautious one.';

// ── Model tier resolution (same classification the UI pickers use) ───
const FAST_RE = /mini|nano|lite|flash|haiku|small/i;
const BEST_RE = /opus|ultra|(^|[^a-z])o[134]([^a-z]|$)|gpt-5|-pro($|[^a-z])/i;

export function tierOfModel(id: string): 'small' | 'medium' | 'large' {
  if (FAST_RE.test(id)) return 'small';
  if (BEST_RE.test(id)) return 'large';
  return 'medium';
}

export function providerOfModel(id: string): string {
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
export const ENGINE_DEFAULT_MODELS: Record<string, string[]> = {
  claude: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
};

export async function loadOrgModels(conn: Connection): Promise<OrgModels> {
  const res = await pkgConn(conn).query<{
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
  // A model the org does not have falls back to the requested TIER rather
  // than killing the build. The designer invents these: told to keep one AI
  // provider across the graph, it emitted modelId 'sales_desk_shared_provider'
  // — a phrase from the requirement, not a model — and eight paid stages
  // died on the last one. Tier resolution already picks a real model, and a
  // working agent on a neighbouring model beats no agent at all. The
  // substitution is noted, never silent.
  if (wanted?.modelId && !org.models.includes(wanted.modelId)) {
    notes.push(
      `'${nodeLabel}': the design asked for model '${wanted.modelId}', which is not enabled here — ` +
        'used one of your enabled models instead. Change it on the canvas if you want a different one.',
    );
  } else if (wanted?.modelId) {
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

/** The provider an AI node runs on, in the AiEngineConnection__c.EngineType__c
 *  vocabulary (Apex normalises the same way: gpt4 -> openai). */
function engineTypeOf(nodeSubType: string): string {
  const s = nodeSubType.toLowerCase();
  if (/claude|anthropic/.test(s)) return 'claude';
  if (/gemini|google/.test(s)) return 'gemini';
  return 'openai';
}

/**
 * THE KEY EACH AI NODE RUNS ON.
 *
 * An agent runs only on the key chosen on its AI node, with no fallback
 * (Apex AiEngineConnectionController.resolveForRuntime). The builder used
 * to save none, so every agent it built refused its first turn with "has
 * no AI key" -- live in the 1 Oct 2026 test run. It now chooses, per
 * provider: the key already on this agent when it is a rebuild, else the
 * org's preferred active key, else the most recently validated active one.
 * None at all is said in a note, never guessed.
 */
export async function chooseAiKeys(
  conn: ReturnType<typeof pkgConn>,
  keptKey: string | null,
  notes: string[],
): Promise<(nodeSubType: string) => string | null> {
  let keys: Array<{ Id: string; EngineType__c: string | null; IsPreferred__c: boolean | null; ValidationStatus__c: string | null; LastValidatedAt__c: string | null }> = [];
  try {
    keys = (await conn.query<(typeof keys)[number]>(
      'SELECT Id, EngineType__c, IsPreferred__c, ValidationStatus__c, LastValidatedAt__c FROM AiEngineConnection__c WHERE IsActive__c = true',
    )).records;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'architect_compile_keys_failed');
  }
  const kept = keptKey ? keys.find(k => k.Id === keptKey) : undefined;
  const missing = new Set<string>();
  return (nodeSubType: string) => {
    const type = engineTypeOf(nodeSubType);
    if (kept && kept.EngineType__c === type) return kept.Id;
    const ofType = keys.filter(k => k.EngineType__c === type);
    const pick = ofType.find(k => k.IsPreferred__c)
      ?? ofType.filter(k => k.ValidationStatus__c === 'Success').sort((a, b) => String(b.LastValidatedAt__c).localeCompare(String(a.LastValidatedAt__c)))[0]
      ?? ofType[0];
    if (!pick && !missing.has(type)) {
      missing.add(type);
      notes.push(`No active ${type} AI key in this org, so this agent cannot run yet: open it in the builder, select its AI node and choose a key.`);
    }
    return pick?.Id ?? null;
  };
}

/** A tool that removes data: by the crud operation, or by what the tool
 *  calls itself for MCP servers and custom actions. */
export function isDeleteAction(toolName: string | undefined, operation: string | undefined): boolean {
  return operation === 'delete' || /delete|destroy|remove|purge/i.test(toolName ?? '');
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
  opts: { conn: Connection; orgId: string; manifest?: CapabilityManifest; existingAgentId?: string; executeType?: 'Chat' | 'Trigger' | 'Both' },
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

  // WHO READS THE REPLIES, not how they arrive.
  //
  // This was inferred from the transport channel, with 'web' counted as
  // customer-facing. But a web chat is a public widget OR a staff tool, and
  // the two want opposite treatment -- live, an internal assistant for
  // account executives was marked customer-facing because its channel was
  // 'web'. The requirement says who the audience is; the channel cannot.
  //
  // So an explicit `audience` wins, and the channel is only consulted when
  // the designer did not say. The remaining channels are ones that reach a
  // third party by definition; 'web' is deliberately not among them,
  // because guessing 'internal' wrongly costs an unenforced guardrail while
  // guessing 'customer' wrongly silently rewrites an employee's answers.
  const customerChannel = spec.audience
    ? spec.audience === 'customer'
    : ['whatsapp', 'sms', 'email'].includes(spec.trigger.channel ?? '');

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
          // An automation agent runs unattended, more than once, and reports
          // what it did: it carries the run rules (run-rules.ts) whatever
          // its own instructions say.
          systemPrompt: opts.executeType === 'Trigger' || opts.executeType === 'Both' ? withRunRules(n.instructions ?? '') : (n.instructions ?? ''),
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
        // Only the Salesforce server's own tools belong in its catalog: a
        // Gmail sendEmail listed there was offered to the model on the wrong server.
        const server = (a.connector ?? '').trim();
        if (!server || server === 'salesforce_mcp' || server === 'Salesforce Platform') mcpToolNames.push(toolName);
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
          // WHICH SERVER PUBLISHES THIS TOOL. The spec has carried
          // `action.connector` all along and this wrote an empty string
          // over it, with two consequences: the inspector showed "Select a
          // connector..." on every tool the Architect built, so a finished
          // agent looked half-configured; and the runtime's
          // providerOfAction falls back to the Salesforce Platform server
          // when this is blank, so a tool from any OTHER connected server
          // was quietly looked for in the wrong place. A standard
          // create/update/query genuinely is the Salesforce server, so it
          // says so rather than relying on the fallback.
          connectorId: a.connector?.trim() || (a.kind === 'crud' ? 'salesforce_mcp' : ''),
          // A delete is always gated, whatever the design said: the designer
          // now leaves a customer-facing agent's ordinary writes ungated,
          // and this keeps that from ever reaching a delete.
          requiresApproval: n.approval?.required === true || isDeleteAction(toolName, a.operation),
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
  // Every connection carries an id. React Flow keys edges by it and
  // silently collapses duplicates, so a graph written without ids rendered
  // as a SINGLE edge on the canvas — a correctly wired agent that looked
  // completely unwired. The hand-built canvas always wrote them; this
  // compiler did not, so the fault showed only on generated agents.
  const edgeId = (from: number, to: number): string => `e${from}:tool-${to}:in`;
  const connections: Array<{ id: string; fromIndex: number; toIndex: number; fromPort: string; toPort: string }> = [];
  for (const e of spec.edges) {
    const from = indexOfSpec.get(e.from);
    const to = indexOfSpec.get(e.to);
    if (from == null || to == null) continue; // node was not compiled (never silently: v1 rejects those above)
    connections.push({ id: edgeId(from, to), fromIndex: from, toIndex: to, fromPort: 'tool', toPort: 'in' });
  }
  const injected = platformNodes.findIndex(p => p.specId === null);
  if (injected >= 0) {
    const rootIndex = indexOfSpec.get(root.id)!;
    connections.push({ id: edgeId(rootIndex, injected), fromIndex: rootIndex, toIndex: injected, fromPort: 'tool', toPort: 'in' });
  }

  // AN AUTOMATION AGENT STARTS AT A TRIGGER NODE, so the compiler adds one.
  //
  // A headless run begins at the graph's trigger node and stops before it
  // begins without one ("No trigger node found"). The Architect's graphs
  // never had one, so an agent it built as automation could not run --
  // and the automation canvas was read-only, so nobody could add it.
  // The subtype follows the spec's trigger; a Flow or Apex call is the
  // 'record' kind, the one Run AI Agent uses.
  if (opts.executeType === 'Trigger' || opts.executeType === 'Both') {
    const rootIndex = indexOfSpec.get(root.id)!;
    const rootNode = platformNodes[rootIndex];
    const subtype = spec.trigger.type === 'webhook' ? 'webhook' : spec.trigger.type === 'schedule' ? 'schedule' : 'record';
    platformNodes.push({
      specId: '__trigger__',
      name: subtype === 'webhook' ? 'Webhook' : subtype === 'schedule' ? 'Schedule' : 'Run from Flow or Apex',
      nodeType: 'trigger',
      nodeSubType: subtype,
      config: {},
      x: Math.max(20, rootNode.x - 260),
      y: rootNode.y,
      enabled: true,
    });
    const triggerIndex = platformNodes.length - 1;
    notes.push('Added a Trigger node so the agent can run from a Flow or Apex — an automation run starts there.');

    if (spec.flow && spec.flow.length > 0) {
      // THE AUTOMATION STEPS. The trigger enters the first step; the root
      // AI node runs only where the flow places an agent step, so a flow
      // that is pure data handling pays for no model call at all.
      const compiled = compileFlow(spec.flow, [{ from: 'start', port: 'out' }], { x: rootNode.x, y: rootNode.y + 240 });
      const base = platformNodes.length;
      compiled.nodes.forEach((f, i) => {
        // An AI step runs on one of the org's own models, at the tier the
        // design asked for, as one unattended step with named outputs.
        if (f.nodeType === 'ai') {
          const tier = (f.config.tier as 'small' | 'medium' | 'large' | undefined) ?? 'medium';
          const { modelId, provider } = resolveModel({ tier } as SpecNode['model'], org, notes, f.name);
          f.nodeSubType = provider;
          f.config = { ...f.config, model: modelId, systemPrompt: AI_STEP_SYSTEM_PROMPT };
        }
        platformNodes.push({
          specId: `__flow_${i}__`, name: f.name, nodeType: f.nodeType, nodeSubType: f.nodeSubType, config: f.config, x: f.x, y: f.y, enabled: true,
        });
      });
      const at = (ref: number | 'agent' | 'start'): number => (ref === 'start' ? triggerIndex : ref === 'agent' ? rootIndex : base + ref);
      for (const e of compiled.edges) {
        const from = at(e.from);
        const to = at(e.to);
        connections.push({ id: `e${from}:${e.port}-${to}:in`, fromIndex: from, toIndex: to, fromPort: e.port, toPort: 'in' });
      }
      notes.push(
        `Built ${compiled.nodes.length} automation step${compiled.nodes.length === 1 ? '' : 's'} after the trigger` +
          (compiled.usesAgent ? ', with the AI agent running where the flow calls for it.' : '. The flow never calls the AI agent, so runs make no model call; the agent stays for chat.'),
      );
    } else {
      connections.push({ id: `e${triggerIndex}:out-${rootIndex}:in`, fromIndex: triggerIndex, toIndex: rootIndex, fromPort: 'out', toPort: 'in' });
    }
  } else if (spec.flow && spec.flow.length > 0) {
    notes.push('The design carried automation steps, but this is a chat agent, so they were not built. Change it to Automation or Both to use them.');
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
  const conn = pkgConn(opts.conn);
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
    // What the Analyst decided (communication / automation / both), or
    // what the person changed it to on the build card. Was always 'Chat'.
    ExecuteType__c: opts.executeType ?? 'Chat',
    CanvasJson__c: JSON.stringify({ connections, spec: { lifecycle: spec.lifecycle, architecture: spec.architecture, trigger: spec.trigger } }),
    SetupChecklistJson__c: JSON.stringify(checklist),
    Version__c: spec.lifecycle?.version ?? 1,
  };

  // EVERY VALUE FITS ITS FIELD. A description one sentence too long
  // failed the save after every paid stage had finished — twice. The
  // lengths come from the org, so this holds for any field, now or later.
  try {
    const d = await conn.sobject('AgentDefinition__c').describe();
    const lengths = new Map<string, number>();
    for (const f of (d as { fields: Array<{ name: string; type?: string; length?: number }> }).fields) {
      if ((f.type === 'string' || f.type === 'textarea' || f.type === 'url' || f.type === 'email') && f.length) lengths.set(f.name, f.length);
    }
    const clipped = fitToLengths(defFields, lengths);
    if (clipped.length) notes.push(`Shortened ${clipped.join(', ')} to fit ${clipped.length === 1 ? 'its field' : 'their fields'} in Salesforce.`);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'architect_compile_describe_failed');
    if (typeof defFields.Description__c === 'string' && defFields.Description__c.length > 255) defFields.Description__c = `${defFields.Description__c.slice(0, 254)}…`;
  }

  // A rebuild replaces the nodes; the key a person chose on the old AI
  // node must survive it, so it is read before they are deleted.
  let keptKey: string | null = null;
  if (agentId) {
    await conn.sobject('AgentDefinition__c').update({ Id: agentId, ...defFields });
    const old = await conn.query<{ Id: string; NodeType__c: string | null; AiEngineConnection__c: string | null }>(
      `SELECT Id, NodeType__c, AiEngineConnection__c FROM AgentNode__c WHERE AgentDefinition__c = '${agentId}'`,
    );
    keptKey = old.records.find(r => r.NodeType__c === 'ai' && r.AiEngineConnection__c)?.AiEngineConnection__c ?? null;
    if (old.records.length > 0) {
      await conn.sobject('AgentNode__c').destroy(old.records.map(r => r.Id));
    }
  } else {
    const created = await conn.sobject('AgentDefinition__c').insert(defFields);
    if (!created.success) throw new CompileError('Could not create the agent record.');
    agentId = created.id as string;
  }

  const keyFor = await chooseAiKeys(conn, keptKey, notes);
  const nodeRows = platformNodes.map((p, i) => ({
    AgentDefinition__c: agentId!,
    ...(p.nodeType === 'ai' || p.nodeType === 'subagent' ? { AiEngineConnection__c: keyFor(p.nodeSubType) } : {}),
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
