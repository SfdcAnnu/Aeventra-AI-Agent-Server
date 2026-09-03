/**
 * The builder Copilot — a persistent chat that can modify an EXISTING agent
 * graph via natural language. Same "N distinct tools, branch on which came
 * back" pattern as generate.ts's ASK/CREATE choice and subagent-router.ts's
 * N-way handoff, extended here to the multi-call case: tool_choice:'auto'
 * lets the model call zero, one, or several of the 6 mutation tools in a
 * single turn (e.g. "add a tool for X and rename the agent" -> two calls),
 * or answer in plain text with no tool calls at all (a question, or a
 * request Archon can't fulfill).
 *
 * This module only PROPOSES operations — it never touches Salesforce. The
 * client stages them, shows a human-readable preview, and only mutates its
 * own graph state on an explicit Apply (propose/Apply/Discard-by-
 * construction — see CopilotPanel.tsx). Nothing here is a source of truth;
 * it's a suggestion generator.
 *
 * Uses OpenAI's Responses API (same adapter chat/adapters/openai.ts already
 * uses for real chat turns), not Claude — this org's only active AI Engine
 * Connection is OpenAI.
 */
import { resolveEngine } from '../chat/engine-resolver';
import type { EngineOverride } from '../chat/engine-resolver';
import { callOpenAi } from '../chat/adapters/openai';
import { NODE_SPEC, CHAT_NODE_SPEC } from './spec';
import type { GeneratorMode } from './generate';
import { LOOKUP_TOOLS, LOOKUP_TOOL_NAMES, executeLookupTool } from './copilot-lookup-tools';
import { logger } from '../logger';

const MODEL = 'gpt-4o';
const MAX_OUTPUT_TOKENS = 4000;
const MAX_LOOKUP_ROUNDS = 4;

export interface CopilotGraphNode {
  id: string;
  label: string;
  nodeType: string;
  nodeSubType: string;
  config: Record<string, unknown>;
}
export interface CopilotGraphConnection {
  id: string;
  fromNodeId: string;
  fromPort: string;
  toNodeId: string;
  toPort: string;
}
export interface CopilotTurn {
  role: 'user' | 'assistant';
  text: string;
}
export interface CopilotRequest {
  mode: GeneratorMode;
  agent: { name: string; department: string; description: string };
  nodes: CopilotGraphNode[];
  connections: CopilotGraphConnection[];
  message: string;
  history?: CopilotTurn[];
}
export interface CopilotOperation {
  tool: string;
  input: Record<string, unknown>;
}
export interface CopilotResult {
  operations: CopilotOperation[];
  /** The model's plain-text reply — a clarifying question, an explanation
   *  of what it's proposing, or a "can't do that" — shown above any
   *  proposed operations regardless of whether there are any. */
  assistantText: string;
}

// OpenAI Responses API function-tool shape is flat (no nested `function`
// wrapper) — matches chat/adapters/openai.ts's own handoff tool defs.
const ADD_NODE_TOOL = {
  type: 'function',
  name: 'add_node',
  description: 'Add a new node to the agent graph.',
  parameters: {
    type: 'object',
    properties: {
      localId: { type: 'string', description: 'A short id you make up for this node (e.g. "new_1") so OTHER tool calls in this SAME turn can reference it before it exists.' },
      label: { type: 'string' },
      nodeType: { type: 'string' },
      nodeSubType: { type: 'string' },
      config: { type: 'object' },
      connectFromNodeId: { type: 'string', description: 'Real id of an existing node, or a localId used earlier in this same turn, to wire this new node FROM. Omit to leave it unconnected.' },
      connectFromPort: { type: 'string', description: 'Required if connectFromNodeId is set.' },
    },
    required: ['localId', 'label', 'nodeType', 'nodeSubType', 'config'],
  },
};
const DELETE_NODE_TOOL = {
  type: 'function',
  name: 'delete_node',
  description: 'Remove a node (and every connection touching it) from the graph. Never delete the sole top-level ai/trigger node.',
  parameters: {
    type: 'object',
    properties: { nodeId: { type: 'string', description: 'Real id of an existing node.' } },
    required: ['nodeId'],
  },
};
const UPDATE_NODE_CONFIG_TOOL = {
  type: 'function',
  name: 'update_node_config',
  description: "Change one or more fields on an existing node's config — only the fields given are changed, everything else on the node is left as-is.",
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Real id of an existing node, or a localId used earlier in this same turn.' },
      configPatch: { type: 'object', description: 'Only the fields to change.' },
    },
    required: ['nodeId', 'configPatch'],
  },
};
const RENAME_NODE_TOOL = {
  type: 'function',
  name: 'rename_node',
  description: "Change a node's display label.",
  parameters: {
    type: 'object',
    properties: {
      nodeId: { type: 'string', description: 'Real id of an existing node, or a localId used earlier in this same turn.' },
      name: { type: 'string' },
    },
    required: ['nodeId', 'name'],
  },
};
const ADD_CONNECTION_TOOL = {
  type: 'function',
  name: 'add_connection',
  description: 'Wire two existing (or just-added, via localId) nodes together.',
  parameters: {
    type: 'object',
    properties: {
      fromNodeId: { type: 'string' },
      fromPort: { type: 'string' },
      toNodeId: { type: 'string' },
      toPort: { type: 'string', description: 'Almost always "in".' },
    },
    required: ['fromNodeId', 'fromPort', 'toNodeId', 'toPort'],
  },
};
const DELETE_CONNECTION_TOOL = {
  type: 'function',
  name: 'delete_connection',
  description: 'Remove one wire between two nodes.',
  parameters: {
    type: 'object',
    properties: { connectionId: { type: 'string', description: 'Real id of an existing connection.' } },
    required: ['connectionId'],
  },
};

const COPILOT_TOOLS = [
  ADD_NODE_TOOL,
  DELETE_NODE_TOOL,
  UPDATE_NODE_CONFIG_TOOL,
  RENAME_NODE_TOOL,
  ADD_CONNECTION_TOOL,
  DELETE_CONNECTION_TOOL,
];

interface FunctionCallBlock { type: 'function_call'; id?: string; call_id?: string; name: string; arguments: string; }

function parseArgs(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

/** Grounded, multi-round proposal: the model may call org LOOKUP tools
 *  (describe_object, list_custom_actions, list_connected_tools) — those
 *  are EXECUTED server-side and fed back, up to MAX_LOOKUP_ROUNDS — while
 *  mutation tool calls are only COLLECTED for the client's propose/Apply
 *  preview, never executed here. This is what lets the copilot verify a
 *  field or action exists before wiring it instead of guessing names. */
export async function proposeCopilotChanges(
  req: CopilotRequest,
  orgId: string,
  engineOverride?: EngineOverride | null,
): Promise<CopilotResult> {
  const creds = resolveEngine('openai', engineOverride);
  const model = creds.defaultModel || MODEL;

  const input: unknown[] = [
    { role: 'system', content: [{ type: 'input_text', text: buildCopilotSystemPrompt(req) }] },
    ...(req.history ?? []).map(h => ({
      role: h.role,
      content: [{ type: h.role === 'assistant' ? 'output_text' : 'input_text', text: h.text }],
    })),
    { role: 'user', content: [{ type: 'input_text', text: req.message }] },
  ];

  const operations: CopilotOperation[] = [];
  let assistantText = '';
  let nudged = false;

  for (let round = 0; round < MAX_LOOKUP_ROUNDS; round++) {
    const response = await callOpenAi(
      {
        model,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        tools: [...LOOKUP_TOOLS, ...COPILOT_TOOLS],
        tool_choice: 'auto',
        input,
      },
      creds.apiKey,
    );
    if (response.error) throw new Error(response.error.message ?? 'OpenAI API error');

    const output = (response.output ?? []) as Array<Record<string, unknown>>;
    const calls = output.filter((b): b is FunctionCallBlock & Record<string, unknown> =>
      b.type === 'function_call' && typeof b.name === 'string');
    const lookups = calls.filter(c => LOOKUP_TOOL_NAMES.has(c.name));
    const mutations = calls.filter(c => !LOOKUP_TOOL_NAMES.has(c.name));

    for (const m of mutations) operations.push({ tool: m.name, input: parseArgs(m.arguments) });

    let text = (response.output_text as string | undefined)?.trim() ?? '';
    if (!text) {
      for (const b of output) {
        if (b.type === 'message' && Array.isArray(b.content)) {
          for (const c of b.content as Array<{ text?: string }>) if (typeof c.text === 'string') text += c.text;
        }
      }
      text = text.trim();
    }
    if (text) assistantText = text; // the latest round's prose wins

    if (lookups.length === 0) {
      // Completeness nudge (once): a multi-part request often gets one
      // mutation per turn out of the model — give it one bounded chance to
      // emit everything still missing (live-confirmed: 1 of 4 requested
      // guardrails without this).
      if (mutations.length > 0 && !nudged && round < MAX_LOOKUP_ROUNDS - 1) {
        nudged = true;
        input.push(...output);
        for (const c of mutations) {
          input.push({ type: 'function_call_output', call_id: c.call_id, output: 'Staged for the user to review and apply.' });
        }
        input.push({
          role: 'user',
          content: [{ type: 'input_text', text: 'Re-read my original request. If any part of it is NOT yet covered by your staged changes, emit ALL remaining tool calls now, together in this one turn. If everything is covered, reply exactly: DONE.' }],
        });
        continue;
      }
      break;
    }

    // Feed lookup results back; unanswered mutation calls in the same round
    // still need an output item or the next request is rejected.
    input.push(...output);
    for (const c of mutations) {
      input.push({ type: 'function_call_output', call_id: c.call_id, output: 'Staged for the user to review and apply.' });
    }
    for (const c of lookups) {
      const result = await executeLookupTool(orgId, c.name, parseArgs(c.arguments));
      input.push({ type: 'function_call_output', call_id: c.call_id, output: result });
    }
    logger.info({ orgId, round, lookups: lookups.map(l => l.name) }, 'copilot_lookup_round');
  }

  if (assistantText.trim() === 'DONE') assistantText = '';
  const validated = validateOperations(operations, req);
  if (validated.notes.length > 0) {
    assistantText = `${assistantText}${assistantText ? '\n\n' : ''}${validated.notes.map(n => `⚠ ${n}`).join('\n')}`;
  }
  return { operations: validated.ops, assistantText };
}

// ── Deterministic post-validation ────────────────────────────────────
// The model proposes; code checks. Wrong-port wiring is auto-corrected
// (the known fromPort:'tool' trap), malformed guardrails are dropped with
// an explanatory note instead of reaching the user's preview.

const RULE_KINDS = new Set(['bannedWords', 'numberLimit']);
const AUTOMATION_MECHANISMS = new Set(['dataCapture', 'followUpAction']);
const AUTOMATION_REQUIRED_KEYS: Record<string, string[]> = {
  dataCapture: ['listenFor', 'extract', 'targetField'],
  followUpAction: ['stageField', 'fromStage', 'toStage'],
};
const SAFE_FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;
const FIELD_KEYS = ['maxDiscountField', 'targetField', 'stageField'];

function badFieldIn(cfg: Record<string, unknown>): string | null {
  const key = FIELD_KEYS.find(k => cfg[k] !== undefined && !SAFE_FIELD_RE.test(String(cfg[k])));
  return key ? String(cfg[key]) : null;
}

function validateOperations(ops: CopilotOperation[], req: CopilotRequest): { ops: CopilotOperation[]; notes: string[] } {
  const notes: string[] = [];
  const typeByRef = new Map<string, string>(req.nodes.map(n => [n.id, n.nodeType]));
  const existingGuardrail = req.nodes.find(n => n.nodeType === 'guardrail');
  const out: CopilotOperation[] = [];
  let batchGuardrailRef: string | null = null;

  for (const op of ops) {
    if (op.tool === 'add_node') {
      const nodeType = String(op.input.nodeType ?? '');
      if (typeof op.input.localId === 'string') typeByRef.set(op.input.localId, nodeType);

      if (nodeType === 'guardrail') {
        const cfg = (op.input.config ?? {}) as Record<string, unknown>;
        const rules = (Array.isArray(cfg.rules) ? cfg.rules : []) as Array<Record<string, unknown>>;
        const validRules = rules.filter(r => {
          if (!r || !RULE_KINDS.has(String(r.kind))) return false;
          if (badFieldIn(r)) { notes.push(`Skipped a rule with invalid field name "${badFieldIn(r)}".`); return false; }
          if (String(r.kind) === 'numberLimit' && !r.maxDiscountField) return false;
          return true;
        });
        if (validRules.length === 0) {
          notes.push(`Dropped guardrail "${String(op.input.label ?? '')}" — no valid rules in config.rules.`);
          continue;
        }
        // ONE guardrail node per agent — merge into an existing node (or an
        // earlier add in this same batch) instead of adding a second.
        if (existingGuardrail) {
          const existingRules = Array.isArray((existingGuardrail.config as Record<string, unknown>).rules)
            ? ((existingGuardrail.config as Record<string, unknown>).rules as unknown[])
            : [];
          out.push({ tool: 'update_node_config', input: { nodeId: existingGuardrail.id, configPatch: { rules: [...existingRules, ...validRules] } } });
          notes.push('Merged new rules into the agent\'s existing Guardrails node (one per agent).');
          continue;
        }
        if (batchGuardrailRef) {
          notes.push('Skipped a second Guardrails node — an agent has exactly one; add rules to it instead.');
          continue;
        }
        batchGuardrailRef = typeof op.input.localId === 'string' ? op.input.localId : 'guardrail';
        op.input.config = { rules: validRules };
      }

      if (nodeType === 'automation') {
        const cfg = (op.input.config ?? {}) as Record<string, unknown>;
        const mech = String(cfg.mechanism ?? '');
        if (!AUTOMATION_MECHANISMS.has(mech)) {
          notes.push(`Dropped automation "${String(op.input.label ?? '')}" — unknown mechanism "${mech}".`);
          continue;
        }
        const missing = AUTOMATION_REQUIRED_KEYS[mech].filter(k => cfg[k] === undefined || cfg[k] === null || cfg[k] === '');
        if (missing.length > 0) {
          notes.push(`Dropped automation "${String(op.input.label ?? '')}" (${mech}) — missing required config: ${missing.join(', ')}.`);
          continue;
        }
        const bad = badFieldIn(cfg);
        if (bad) {
          notes.push(`Dropped automation "${String(op.input.label ?? '')}" — "${bad}" is not a valid field API name.`);
          continue;
        }
      }

      // The fromPort:'tool' trap — a subagent/tool/guardrail/automation
      // wired on any other port renders connected but is invisible at runtime.
      if (['subagent', 'tool', 'catalog', 'guardrail', 'automation'].includes(nodeType) &&
          typeof op.input.connectFromNodeId === 'string' && op.input.connectFromPort !== 'tool') {
        op.input.connectFromPort = 'tool';
        notes.push(`Corrected wiring for "${String(op.input.label ?? '')}" to the required "tool" port.`);
      }
    }

    if (op.tool === 'add_connection') {
      const targetType = typeByRef.get(String(op.input.toNodeId ?? ''));
      if (targetType && ['subagent', 'tool', 'catalog', 'guardrail', 'automation'].includes(targetType) && op.input.fromPort !== 'tool') {
        op.input.fromPort = 'tool';
        notes.push('Corrected a connection to the required "tool" port.');
      }
    }

    out.push(op);
  }
  return { ops: out, notes };
}

function buildCopilotSystemPrompt(req: CopilotRequest): string {
  const spec = req.mode === 'chat' ? CHAT_NODE_SPEC : NODE_SPEC;
  const nodeBlock = spec
    .map(n => `- type="${n.type}" subType="${n.subType}" ("${n.label}") — ${n.when}`)
    .join('\n');

  const graphBlock = req.nodes
    .map(n => `- id="${n.id}" label="${n.label}" type="${n.nodeType}" subType="${n.nodeSubType}" config=${JSON.stringify(n.config)}`)
    .join('\n') || '(no nodes yet)';

  const connectionsBlock = req.connections
    .map(c => `- id="${c.id}" ${c.fromNodeId} --[${c.fromPort}]--> ${c.toNodeId} (toPort="${c.toPort}")`)
    .join('\n') || '(no connections yet)';

  const portRule = req.mode === 'chat'
    ? '\nCRITICAL: any connection targeting a "subagent" or "tool" node MUST use fromPort="tool" exactly — this is the literal port name the chat engine matches on. Any other value makes that node invisible and uncallable at runtime even though it looks connected. Catalog node connections should also use fromPort="tool" for consistency.'
    : '';

  return `You are Archon's builder Copilot — a chat assistant that modifies an EXISTING ${req.mode === 'chat' ? 'chat' : 'automation'} agent's graph on request, using the tools provided.

AGENT: "${req.agent.name}" (${req.agent.department}) — ${req.agent.description || 'no description'}

CURRENT NODES:
${graphBlock}

CURRENT CONNECTIONS:
${connectionsBlock}

VALID NODE TYPES FOR THIS AGENT:
${nodeBlock}
${portRule}

ORG GROUNDING (lookup tools — describe_object, list_custom_actions, list_connected_tools):
- NEVER invent Salesforce field names, picklist values, action names, or tool names. Before any config that references one (a guardrail's targetField/maxDiscountField/stageField/fromStage/toStage, a tool node's toolName, catalog allowedTools), CALL the lookup tools first and use the exact API names and real picklist values they return.
- Lookups run immediately and their results come back to you in this same conversation — do lookups first, then propose the mutations. If a lookup shows the thing doesn't exist, say so instead of wiring a guess.

GUARDRAILS vs AUTOMATIONS (both enforced in code by the server — never prompt text):
- GUARDRAILS (nodeType "guardrail") are the agent's RESTRICTION RULES — "must never say X", "never below Y". AT MOST ONE guardrail node per agent; ALL rules go in its config.rules array:
    {"rules":[{"kind":"bannedWords","bannedWords":["cost price"]},{"kind":"numberLimit","maxDiscountField":"<verified % field on Product2>","firstOfferPct":12,"defaultMaxPct":15}]}
  If a guardrail node already exists, ADD to it via update_node_config with the FULL new rules array — never add a second guardrail node.
- AUTOMATIONS (nodeType "automation") are system WORK that happens automatically — capture mentioned data, move a stage after an escalation. One node per job, any number. EXACT config shapes:
    {"mechanism":"dataCapture","listenFor":"<full plain-language description>","extract":["Vendor","Price","Includes"],"targetField":"<verified field>","keywords":["vendor","price","offer"]}
    {"mechanism":"followUpAction","stageField":"<verified picklist field>","fromStage":"<real value>","toStage":"<real value>"}
- Both connect FROM the top-level ai node with fromPort="tool", toPort="in".
- When adding either to a customer-facing agent, also ensure the root ai node's config has customerFacing=true (update_node_config).
- Verify every field/stage value with describe_object before writing it into any config.

HOW TO RESPOND:
- If the request is a genuine, buildable change, call one or more of the mutation tools to make it. COVER THE WHOLE REQUEST: a request with several parts needs ALL its tool calls emitted together in one turn — never just the first part. Reference EXISTING nodes/connections by their real "id" shown above; a node you add in this same turn is referenced by the localId you gave it.
- If the request is ambiguous, or you need one clarifying detail, ask in plain text and make NO mutation calls this turn.
- If the request is something Archon genuinely can't do (see the valid node types above), say so plainly and make no mutation calls.
- Never delete the agent's sole top-level node (the one everything else attaches to).
- Keep any plain-text reply short — one or two sentences. The user sees a separate structured preview of whatever you propose; you don't need to restate it in prose.`;
}
