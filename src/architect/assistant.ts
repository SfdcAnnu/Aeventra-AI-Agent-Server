/**
 * The Architect's two interactive surfaces, both read-only against the
 * client org and both grounded in what the Surveyor can actually find:
 *
 *   rewritePrompt() — the ✦ on an instructions box. Takes whatever the
 *   client wrote (any language, any level of polish) and returns proper
 *   instructions written FOR THE MODEL THAT WILL RUN THEM: a reasoning
 *   model gets a short goal-shaped prompt with no "think step by step",
 *   a gpt-4-class model gets structure and an example, Claude gets prose
 *   and a clear role. The client's meaning is preserved exactly; only the
 *   craft changes.
 *
 *   copilotTurn() — "Ask Archon". Answers questions about the org and the
 *   open agent, and proposes CONFIG changes as typed operations the UI
 *   previews and the user applies. It can never invent a tool (every
 *   proposal is checked against the live capability manifest) and it never
 *   writes anything itself.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import { logger } from '../logger';
import { callSpecialist, resolveArchitectEngine, type ArchitectEngine } from './specialists';
import { buildCapabilityManifest, describeObjectCompact, listInvocables, listMcpToolsLive } from './surveyor-tools';

let styleCache: string | null = null;
function modelStyles(): string {
  if (!styleCache) {
    styleCache = readFileSync(join(process.cwd(), 'architect', 'knowledge', 'model-prompt-styles.md'), 'utf8');
  }
  return styleCache;
}

// ── ✦ Rewrite this instruction ───────────────────────────────────────
export interface RewriteInput {
  /** Whatever the client typed — any language, any polish. */
  draft: string;
  /** 'agent' (root) | 'subagent' | 'tool' — a tool's text is a routing
   *  description, which is a different job from an agent's role. */
  role: 'agent' | 'subagent' | 'tool';
  /** The model this node will actually run on. */
  modelId: string;
  agentName?: string;
  department?: string;
  channel?: string;
  /** Names of the tools this node can reach, so the text can refer to
   *  capabilities that exist rather than inventing them. */
  toolNames?: string[];
}

export async function rewritePrompt(
  conn: Connection,
  input: RewriteInput,
): Promise<{ instructions: string; changed: string[]; costUsd: number }> {
  const engine = await resolveArchitectEngine(conn);

  const roleBrief =
    input.role === 'tool'
      ? 'This is a TOOL ROUTING DESCRIPTION: one or two sentences saying WHEN the agent should reach for this tool. Not a procedure, not a payload, not business rules.'
      : input.role === 'subagent'
        ? "This is a SPECIALIST's instructions: the role it plays once the lead agent hands it a task, and the boundaries it works inside."
        : "This is the ROOT agent's instructions: who it is, how it speaks, what it must never do.";

  const { result, usage } = await callSpecialist<{ instructions: string; changed: string[] }>({
    specialistId: 'write_prompts',
    engine,
    includeKnowledge: false, // this task needs style guidance, not the spec schema
    maxOutputTokens: 2000,
    input: {
      task:
        'Rewrite the draft below as production-quality instructions. Preserve the author\'s intent and every ' +
        'concrete rule they stated — you are improving the craft, not the decisions. If the draft is in another ' +
        'language, write the result in English unless the draft is clearly the customer-facing wording itself. ' +
        'Return JSON: { "instructions": "...", "changed": ["short note per substantive improvement"] }.',
      roleBrief,
      writeFor: {
        model: input.modelId,
        guidance: modelStyles(),
      },
      context: {
        agentName: input.agentName,
        department: input.department,
        channel: input.channel,
        toolsAvailable: input.toolNames ?? [],
      },
      draft: input.draft,
    },
    rawJson: true,
  });

  const instructions = String(result?.instructions ?? '').trim();
  if (!instructions) throw new Error('The rewrite came back empty — your original text is untouched.');
  return {
    instructions,
    changed: Array.isArray(result?.changed) ? result.changed.slice(0, 6).map(String) : [],
    costUsd: usage.costUsd,
  };
}

// ── ✦ Ask Archon (the copilot) ───────────────────────────────────────
export type CopilotOperation =
  | { kind: 'setInstructions'; nodeId: string; value: string; why: string }
  | { kind: 'setDescription'; nodeId: string; value: string; why: string }
  | { kind: 'setRoutingDescription'; nodeId: string; value: string; why: string }
  | { kind: 'setModel'; nodeId: string; value: string; why: string }
  | { kind: 'setApproval'; nodeId: string; value: boolean; why: string }
  | { kind: 'setContextPolicy'; nodeId: string; value: 'isolated' | 'windowed' | 'full'; why: string }
  | { kind: 'setMode'; nodeId: string; value: 'call' | 'transfer'; why: string };

const OP_KINDS = new Set([
  'setInstructions',
  'setDescription',
  'setRoutingDescription',
  'setModel',
  'setApproval',
  'setContextPolicy',
  'setMode',
]);

export interface CopilotGraphNode {
  id: string;
  name: string;
  nodeType: string;
  nodeSubType: string;
  config: Record<string, unknown>;
}

export interface CopilotInput {
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  agent?: {
    apiName: string;
    name: string;
    department?: string;
    nodes: CopilotGraphNode[];
  };
}

export interface CopilotResult {
  reply: string;
  operations: CopilotOperation[];
  costUsd: number;
}

/** Cheap, bounded org context: what exists, not everything about it. */
async function orgContext(orgId: string, message: string): Promise<Record<string, unknown>> {
  const wantsObject = /\b(field|object|record|opportunity|account|contact|case|lead|quote|order)\b/i.test(message);
  const [invocables, mcp] = await Promise.all([
    listInvocables(orgId).catch(() => []),
    listMcpToolsLive(orgId).catch(() => []),
  ]);
  const ctx: Record<string, unknown> = {
    invocableApex: invocables.filter(i => i.kind === 'apex').slice(0, 40).map(i => i.name),
    flows: invocables.filter(i => i.kind === 'flow').slice(0, 40).map(i => i.name),
    mcpTools: mcp.flatMap(m => m.tools.map(t => t.name)).slice(0, 60),
  };
  if (wantsObject) {
    const named = message.match(/\b(Opportunity|Account|Contact|Case|Lead|Quote|Order|Product2|Contract)\b/i);
    if (named) {
      const desc = await describeObjectCompact(orgId, named[0], 45).catch(() => null);
      if (desc) ctx.objectAsked = { name: desc.name, fields: desc.fields.map(f => `${f.name} (${f.type}${f.required ? ', required' : ''})`) };
    }
  }
  return ctx;
}

export async function copilotTurn(
  conn: Connection,
  orgId: string,
  input: CopilotInput,
): Promise<CopilotResult> {
  const engine = await resolveArchitectEngine(conn);
  const [ctx, manifestBuilt] = await Promise.all([
    orgContext(orgId, input.message),
    buildCapabilityManifest(orgId).catch(() => null),
  ]);

  const nodes = (input.agent?.nodes ?? []).map(n => ({
    id: n.id,
    name: n.name,
    type: n.nodeType,
    model: (n.config.model as string) ?? n.nodeSubType,
    instructions: typeof n.config.systemPrompt === 'string' ? (n.config.systemPrompt as string).slice(0, 1200) : undefined,
    description: (n.config.description as string) ?? (n.config.routingDescription as string),
    requiresApproval: n.config.requiresApproval,
    mode: n.config.mode,
    contextPolicy: n.config.contextPolicy,
  }));

  const { result, usage } = await callSpecialist<{ reply?: string; operations?: CopilotOperation[] }>({
    specialistId: 'plan_change',
    engine,
    includeKnowledge: true,
    maxOutputTokens: 3000,
    rawJson: true,
    input: {
      task:
        'You are Archon, helping inside the agent builder. Answer the user in plain language — their vocabulary, ' +
        'never API names or JSON. When they ask for a CHANGE to the open agent, return operations that make it. ' +
        'When they ask what is possible, answer from the org context and say plainly when something is missing. ' +
        'Return JSON: { "reply": "...", "operations": [...] }. Operations may only be: setInstructions, ' +
        'setDescription, setRoutingDescription, setModel, setApproval, setContextPolicy, setMode — each with ' +
        'nodeId, value and a one-line why. Propose NO operations for a question. Never name a tool, Flow or ' +
        'invocable that is not in the org context; if one is needed and missing, say so instead.',
      promptStyleGuidance: modelStyles(),
      openAgent: input.agent ? { apiName: input.agent.apiName, name: input.agent.name, department: input.agent.department, nodes } : null,
      orgContext: ctx,
      conversation: (input.history ?? []).slice(-8),
      userMessage: input.message,
    },
  });

  const ids = new Set(nodes.map(n => n.id));
  const operations = (Array.isArray(result?.operations) ? result!.operations : [])
    .filter(op => op && OP_KINDS.has((op as { kind?: string }).kind ?? ''))
    // A proposal against a node that is not on the canvas is a
    // hallucination, not an edit — drop it rather than confuse the diff.
    .filter(op => ids.has((op as { nodeId?: string }).nodeId ?? ''))
    .slice(0, 8);

  if (manifestBuilt) {
    // setModel is the only operation naming an external identity; the rest
    // are text the user reviews anyway.
    for (const op of operations) {
      if (op.kind === 'setModel' && !op.value) op.why = 'model unchanged — no model was named';
    }
  }

  const reply = String(result?.reply ?? '').trim() || "I'm not sure how to help with that one.";
  logger.info({ orgId, ops: operations.length, costUsd: Number(usage.costUsd.toFixed(4)) }, 'architect_copilot_turn');
  return { reply, operations, costUsd: usage.costUsd };
}
