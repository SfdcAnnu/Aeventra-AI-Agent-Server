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

const MODEL = 'gpt-4o';
const MAX_OUTPUT_TOKENS = 4000;

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

export async function proposeCopilotChanges(req: CopilotRequest, engineOverride?: EngineOverride | null): Promise<CopilotResult> {
  const creds = resolveEngine('openai', engineOverride);
  const model = creds.defaultModel || MODEL;

  const input: Array<{ role: string; content: Array<Record<string, unknown>> }> = [
    { role: 'system', content: [{ type: 'input_text', text: buildCopilotSystemPrompt(req) }] },
    ...(req.history ?? []).map(h => ({
      role: h.role,
      content: [{ type: h.role === 'assistant' ? 'output_text' : 'input_text', text: h.text }],
    })),
    { role: 'user', content: [{ type: 'input_text', text: req.message }] },
  ];

  const response = await callOpenAi(
    {
      model,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      tools: COPILOT_TOOLS,
      tool_choice: 'auto',
      input,
    },
    creds.apiKey,
  );
  if (response.error) throw new Error(response.error.message ?? 'OpenAI API error');

  const output = response.output ?? [];
  const operations: CopilotOperation[] = output
    .filter((b): b is FunctionCallBlock => b.type === 'function_call' && (b as FunctionCallBlock).name != null)
    .map(b => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(b.arguments);
      } catch {
        parsed = {};
      }
      return { tool: b.name, input: parsed as Record<string, unknown> };
    });

  let assistantText = response.output_text?.trim() ?? '';
  if (!assistantText) {
    for (const b of output) {
      if (b.type === 'message' && Array.isArray(b.content)) {
        for (const c of b.content) if (typeof c.text === 'string') assistantText += c.text;
      }
    }
    assistantText = assistantText.trim();
  }

  return { operations, assistantText };
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

HOW TO RESPOND:
- If the request is a genuine, buildable change, call one or more of the 6 tools to make it — you may call several tools in one turn (e.g. add a node AND rename the agent's own step). Reference EXISTING nodes/connections by their real "id" shown above; a node you add in this same turn is referenced by the localId you gave it.
- If the request is ambiguous, or you need one clarifying detail, ask in plain text and make NO tool calls this turn.
- If the request is something Archon genuinely can't do (see the valid node types above), say so plainly and make no tool calls.
- Never delete the agent's sole top-level node (the one everything else attaches to).
- Keep any plain-text reply short — one or two sentences. The user sees a separate structured preview of whatever you propose; you don't need to restate it in prose.`;
}
