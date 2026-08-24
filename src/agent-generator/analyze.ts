/**
 * Agent generation v2, pass 1: capability analysis.
 *
 * Instead of jumping straight to a graph, the model first extracts WHAT the
 * agent needs to be able to do, and resolves each capability against the
 * org grounding pack (live MCP tools, existing Apex/Flows, real objects —
 * see grounding.ts). Output per capability:
 *   - resolved  — provably realizable today; carries the exact binding
 *   - question  — the org can't answer it; carries ONE concrete question
 *                 with options (+ the client renders a free-text "Other")
 *   - no_node   — real requirement, but belongs in instructions/automation
 *                 rather than a node; carries the explanation
 *
 * Pass 1.5 (verifyOtherAnswer) interprets a free-text "Other" answer
 * against the same grounding. Round discipline is enforced HERE, not in
 * the UI: round 1 may return one follow-up question; round 2 is forced to
 * finalize (bind, fall back to the recommended option, or explicitly
 * defer) — the user is never looped.
 */
import { resolveEngine } from '../chat/engine-resolver';
import type { EngineOverride } from '../chat/engine-resolver';
import { callOpenAi } from '../chat/adapters/openai';
import { renderGrounding, type GroundingPack } from './grounding';
import type { GeneratorMode } from './generate';

const MODEL = 'gpt-4o';
const MAX_OUTPUT_TOKENS = 6000;

// ── Shared plan types (serialized to the client verbatim) ────────────

export type CapabilityResolution =
  | { kind: 'catalog'; provider: string; allowedTools: string[]; description: string }
  | { kind: 'mcp_tool'; provider: string; toolName: string; description: string }
  | { kind: 'apex_tool'; name: string; description: string }
  | { kind: 'flow_tool'; name: string; description: string }
  | { kind: 'instruction'; note: string }
  | { kind: 'deferred'; checklistTitle: string; description: string };

export interface CapabilityOption {
  id: string;
  label: string;
  description: string;
  resolution: CapabilityResolution;
}

export interface Capability {
  id: string;
  title: string;
  requirementQuote: string;
  status: 'resolved' | 'question' | 'no_node';
  /** Set when the agent needs specialist domains: the subagent this
   *  capability's tools belong under (e.g. "Verification"). Absent =
   *  attached to the root agent. Drives the Review screen's grouping and
   *  the generation contract. */
  domain?: string;
  resolution?: CapabilityResolution;
  explanation?: string;
  question?: {
    text: string;
    options: CapabilityOption[];
    recommendedId: string;
  };
}

export interface CapabilityPlan {
  agentName: string;
  capabilities: Capability[];
}

// ── Pass 1: analyze ─────────────────────────────────────────────────

const RESOLUTION_SCHEMA = {
  type: 'object',
  description: 'Exactly ONE of the binding shapes, discriminated by "kind".',
  properties: {
    kind: { type: 'string', enum: ['catalog', 'mcp_tool', 'apex_tool', 'flow_tool', 'instruction', 'deferred'] },
    provider: { type: 'string', description: 'MCP provider key (catalog/mcp_tool only) — must be a CONNECTED server from the grounding.' },
    allowedTools: { type: 'array', items: { type: 'string' }, description: 'catalog only — EXACT live tool names from that server.' },
    toolName: { type: 'string', description: 'mcp_tool only — EXACT live tool name.' },
    name: { type: 'string', description: 'apex_tool/flow_tool only — EXACT action name from ORG AUTOMATION.' },
    description: { type: 'string', description: 'What this binding does, shown to the user and later to the agent.' },
    note: { type: 'string', description: 'instruction only — why no node is needed and where the behavior lives instead.' },
    checklistTitle: { type: 'string', description: 'deferred only.' },
  },
  required: ['kind'],
};

const ANALYZE_TOOL = {
  type: 'function',
  name: 'propose_capability_plan',
  description: 'Report every capability the requirement implies, each resolved against the org grounding or turned into ONE clear question.',
  parameters: {
    type: 'object',
    properties: {
      agentName: { type: 'string' },
      capabilities: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Short slug, e.g. "otp-verification".' },
            title: { type: 'string' },
            requirementQuote: { type: 'string', description: 'Short quote/paraphrase of the requirement line this comes from.' },
            status: { type: 'string', enum: ['resolved', 'question', 'no_node'] },
            domain: { type: 'string', description: 'ONLY when the agent needs specialist domains (see structure rules): the subagent this capability belongs under, e.g. "Verification". Omit for root/common capabilities.' },
            resolution: RESOLUTION_SCHEMA,
            explanation: { type: 'string', description: 'no_node only — why this needs no node (user-facing, one sentence).' },
            question: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'One concrete question, plain language.' },
                options: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      label: { type: 'string' },
                      description: { type: 'string', description: 'What happens if chosen — concrete, names the real tools/actions used.' },
                      resolution: RESOLUTION_SCHEMA,
                    },
                    required: ['id', 'label', 'description', 'resolution'],
                  },
                },
                recommendedId: { type: 'string' },
              },
              required: ['text', 'options', 'recommendedId'],
            },
          },
          required: ['id', 'title', 'requirementQuote', 'status'],
        },
      },
    },
    required: ['agentName', 'capabilities'],
  },
};

export interface AnalyzeRequest {
  orgId: string;
  requirementText: string;
  mode: GeneratorMode;
  grounding: GroundingPack;
}

export async function analyzeRequirement(req: AnalyzeRequest, engineOverride?: EngineOverride | null): Promise<CapabilityPlan> {
  const creds = resolveEngine('openai', engineOverride);
  const model = creds.defaultModel || MODEL;

  const system = `You are Archon's agent-generation analyst. Extract the capabilities a ${req.mode === 'chat' ? 'conversational chat' : 'record-triggered automation'} agent needs from the requirement, and resolve EVERY one against the org's real assets below. Rules:
- A capability that maps onto the grounding (a live MCP tool, an existing Apex action or Flow, real object fields) is "resolved" — carry the exact binding with EXACT names from the grounding. Never invent a tool, action, flow, object, or field name.
- Salesforce-record work (lookups, updates, creating records/cases/tasks) belongs in ONE "catalog" resolution on provider salesforce_mcp with only the needed live tool names — or a dedicated "mcp_tool" resolution when the requirement calls out one specific named action.
- If an existing Flow or Apex action already implements a capability (check ORG AUTOMATION by name/label), prefer binding to it (flow_tool/apex_tool) over anything else.
- A capability the org genuinely cannot answer becomes ONE "question": 2-3 concrete options, each with a real resolution attached (options may use "deferred" for connect-later), plus a recommended option. Write for a business user — no jargon.
- A requirement line that should NOT be a node (greeting behavior, tone rules, conversation flow) is "no_node" with a one-sentence explanation.
- Be exhaustive but not inventive: every capability must trace to the requirement.

STRUCTURE RULES (enterprise scaling — how capabilities become graph structure):
- One catalog per provider per owner, never more. Plain lookups/queries belong in the catalog, NEVER as individual named tools.
- A named tool ("mcp_tool"/"apex_tool"/"flow_tool") earns its place only when the action has distinct business meaning the agent must choose deliberately, or needs an approval gate. Several named tools MAY share the same underlying server tool — their descriptions are what differ.
- Count the capabilities that would attach to the root agent. If they exceed ~8, OR the requirement clearly describes 2+ distinct specialist domains (e.g. verification vs. loan servicing vs. complaints), assign a "domain" to each non-common capability — each domain becomes a subagent owning those tools. Keep identification/common lookups on the root (no domain). Aim for <=8 tools per domain.
- Never plan more than one level of domains — subagents cannot have subagents.

${renderGrounding(req.grounding)}`;

  const response = await callOpenAi(
    {
      model,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      tools: [ANALYZE_TOOL],
      tool_choice: { type: 'function', name: 'propose_capability_plan' },
      input: [
        { role: 'system', content: [{ type: 'input_text', text: system }] },
        { role: 'user', content: [{ type: 'input_text', text: `REQUIREMENT:\n${req.requirementText.trim()}` }] },
      ],
    },
    creds.apiKey,
  );
  if (response.error) throw new Error(response.error.message ?? 'OpenAI API error');

  const call = (response.output ?? []).find(
    (b): b is { type: 'function_call'; name: string; arguments: string } => b.type === 'function_call',
  );
  if (!call) throw new Error('The analyzer returned no capability plan. Try rephrasing the requirement.');

  let plan: CapabilityPlan;
  try {
    plan = JSON.parse(call.arguments) as CapabilityPlan;
  } catch {
    throw new Error('The analyzer returned an unreadable plan. Try again.');
  }
  plan.capabilities = (plan.capabilities ?? []).filter(c => c && c.id && c.status);
  return plan;
}

// ── Pass 1.5: verify a free-text "Other" answer ─────────────────────

const RESOLVE_TOOL = {
  type: 'function',
  name: 'resolve_capability',
  description: "Finalize this capability from the user's own description — bind it to something real from the grounding, or explicitly defer it.",
  parameters: {
    type: 'object',
    properties: {
      resolution: RESOLUTION_SCHEMA,
      userSummary: { type: 'string', description: 'One sentence back to the user: what was understood and what it is now bound to.' },
    },
    required: ['resolution', 'userSummary'],
  },
};

const FOLLOWUP_TOOL = {
  type: 'function',
  name: 'ask_followup',
  description: 'Ask ONE final clarifying question — only if genuinely impossible to finalize. This is the last question the user will see.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      options: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            description: { type: 'string' },
            resolution: RESOLUTION_SCHEMA,
          },
          required: ['id', 'label', 'description', 'resolution'],
        },
      },
      recommendedId: { type: 'string' },
    },
    required: ['text', 'options', 'recommendedId'],
  },
};

export interface VerifyRequest {
  orgId: string;
  mode: GeneratorMode;
  grounding: GroundingPack;
  capability: Capability;
  answerText: string;
  /** 1 = first free-text answer (one follow-up allowed); 2 = answer to the
   *  follow-up (finalization forced). */
  round: number;
}

export type VerifyResult =
  | { kind: 'resolved'; resolution: CapabilityResolution; userSummary: string }
  | { kind: 'question'; question: NonNullable<Capability['question']> };

export async function verifyOtherAnswer(req: VerifyRequest, engineOverride?: EngineOverride | null): Promise<VerifyResult> {
  const creds = resolveEngine('openai', engineOverride);
  const model = creds.defaultModel || MODEL;
  const canFollowUp = req.round < 2;

  const system = `You are finalizing ONE capability of an agent being generated, based on the user's own description. Match their description against the org's real assets below and bind to the closest real thing (a live MCP tool, an existing Apex action or Flow — match loosely on names/labels, users abbreviate). If they describe something external that doesn't exist yet, use a "deferred" resolution with a clear checklist title. ${canFollowUp ? 'Only if you truly cannot decide, you may ask ONE final follow-up question.' : 'You MUST finalize now — no more questions. When in doubt, choose the safest reasonable binding or defer.'}

CAPABILITY BEING RESOLVED: ${req.capability.title} — "${req.capability.requirementQuote}"
ORIGINAL QUESTION ASKED: ${req.capability.question?.text ?? '(none)'}

${renderGrounding(req.grounding)}`;

  const response = await callOpenAi(
    {
      model,
      max_output_tokens: 2500,
      tools: canFollowUp ? [RESOLVE_TOOL, FOLLOWUP_TOOL] : [RESOLVE_TOOL],
      tool_choice: canFollowUp ? 'required' : { type: 'function', name: 'resolve_capability' },
      input: [
        { role: 'system', content: [{ type: 'input_text', text: system }] },
        { role: 'user', content: [{ type: 'input_text', text: `THE USER'S OWN DESCRIPTION:\n${req.answerText.trim()}` }] },
      ],
    },
    creds.apiKey,
  );
  if (response.error) throw new Error(response.error.message ?? 'OpenAI API error');

  const call = (response.output ?? []).find(
    (b): b is { type: 'function_call'; name: string; arguments: string } => b.type === 'function_call',
  );
  if (!call) throw new Error('Could not interpret the answer. Try rewording it.');

  const args = JSON.parse(call.arguments);
  if (call.name === 'ask_followup') {
    return { kind: 'question', question: { text: args.text, options: args.options ?? [], recommendedId: args.recommendedId } };
  }
  return { kind: 'resolved', resolution: args.resolution, userSummary: args.userSummary ?? '' };
}
