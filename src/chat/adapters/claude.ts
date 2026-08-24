/**
 * Claude adapter — uses Anthropic's Managed MCP.
 *
 * We just point the Messages API at the MCP server URL + pass the SF
 * access_token. Anthropic handles the entire MCP protocol: session
 * initialization, tools/list, tools/call, feeding results back to itself,
 * final assistant text.
 *
 * We don't manage tool loops or JSON-RPC sessions. The `mcp_servers` field
 * in the request body is doing all the work.
 *
 * Mirrors the pattern in `MCP with claude example/server.js`.
 */

import { logger } from '../../logger';
import type { AgentNode } from '../../types';
import { InstallsRepo } from '../../db/installs.repo';
import { buildSystemPrompt, resolveMcpServers, type ResolvedMcpServer } from './shared';
import { loadAttachments, type LoadedAttachment } from './attachments';
import { resolveEngine } from '../engine-resolver';
import type { HandoffToolDef } from '../subagent-router';
import type {
  ChatHistoryMessage,
  ChatTurnRequest,
  ChatTurnResult,
  ToolCallSummary,
  PolicyViolation,
} from './types';

const ANTHROPIC_URL     = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA    = 'mcp-client-2025-11-20';

/** Minimum shape of blocks in Anthropic message content. */
interface AnthropicBlock {
  type:              string;
  text?:             string;
  id?:               string;
  name?:             string;
  server_name?:      string;
  input?:            Record<string, unknown>;
  tool_use_id?:      string;
  content?:          Array<{ type: string; text?: string }>;
  is_error?:         boolean;
}

interface AnthropicResponse {
  id:      string;
  type:    string;
  role:    'assistant';
  model:   string;
  content: AnthropicBlock[];
  usage?:  { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
  error?:  { type: string; message: string };
}

/**
 * Shared by both the normal return path AND the subagent-handoff early
 * return — a handoff decision can arrive in the SAME response as one or
 * more already-executed mcp_tool_use calls (Anthropic's managed-MCP loop
 * runs those server-side before handing control back for a client-defined
 * tool like a handoff), so both call sites need identical extraction/policy
 * logic rather than the handoff path silently dropping real, billed,
 * already-executed actions.
 */
function extractToolCallsAndViolations(
  content: AnthropicBlock[],
  servers: ResolvedMcpServer[],
  orgId: string,
): { toolCalls: ToolCallSummary[]; policyViolations: PolicyViolation[] } {
  const toolCalls: ToolCallSummary[] = [];
  const toolUses    = content.filter(b => b.type === 'mcp_tool_use');
  const toolResults = content.filter(b => b.type === 'mcp_tool_result');
  for (const use of toolUses) {
    const result = toolResults.find(r => r.tool_use_id === use.id);
    let resultText = '';
    if (result?.content && result.content.length > 0) {
      resultText = result.content[0].text ?? '';
    }
    toolCalls.push({
      id:    use.id ?? '',
      name:  use.name ?? '',
      input: use.input ?? {},
      output: resultText,
      isError: result?.is_error ?? false,
      serverName: use.server_name ?? undefined,
    });
  }

  // Can't stop these calls before they happen (Anthropic's servers already
  // executed them against the remote MCP server by the time we see this
  // response — Claude can't hard-filter allowed tools yet, see the
  // restrictionPrompt comment in runClaudeAdapter). What we CAN do is
  // refuse to treat an out-of-policy result as good data: detect the
  // violation and let the caller fail loudly instead of silently
  // succeeding on a response the model wasn't supposed to produce.
  const policyViolations: PolicyViolation[] = [];
  for (const call of toolCalls) {
    const server = servers.find(s => s.name === call.serverName);
    if (!server || server.allowedTools.length === 0) continue;
    if (!server.allowedTools.includes(call.name)) {
      policyViolations.push({ serverName: server.name, tool: call.name, allowedTools: server.allowedTools });
    }
  }
  if (policyViolations.length > 0) {
    logger.error({ orgId, policyViolations }, 'claude_adapter_policy_violation');
  }
  return { toolCalls, policyViolations };
}

export async function runClaudeAdapter(
  req: ChatTurnRequest,
  aiNode: AgentNode,
  handoffTools: HandoffToolDef[] = [],
): Promise<ChatTurnResult> {
  // Resolve credentials: per-user override from Apex → fall back to .env
  const creds = resolveEngine('claude', req.engineOverride);
  const apiKey = creds.apiKey;

  const install = await InstallsRepo.findByOrgId(req.context.orgId);
  if (!install?.sfAccessToken) {
    throw new Error('Org has no Salesforce tokens. Admin must run Synapse Setup first.');
  }

  const model         = creds.defaultModel || (aiNode.config as { model?: string })?.model || 'claude-sonnet-4-6';
  const systemPrompt  = await buildSystemPrompt(req.agent, aiNode, req.context, req.newUserMessage, req.engineOverride, req.memoryPreamble);
  // Attachments are opt-in. When the turn has none, we make ZERO Salesforce
  // calls, ZERO jsforce init, ZERO extra latency — the adapter goes straight
  // to Anthropic.
  const attachments = (req.attachments && req.attachments.length > 0)
    ? await loadAttachments(req.context.orgId, req.attachments)
    : [];
  const messages = mapHistoryForClaude(req.history, req.newUserMessage, attachments);

  // Multi-connector: Salesforce sends connectors[] each turn; we attach the
  // right token per provider. Legacy fallback = single env-configured SF MCP.
  const servers = await resolveMcpServers(req, aiNode, install.sfAccessToken);
  if (servers.length === 0) {
    throw new Error('No MCP servers available for this agent. Bind a connector on the canvas, or set SF_REMOTE_MCP_URL.');
  }

  const mcpServers = servers.map(s => ({
    type: 'url',
    url:  s.url,
    name: s.name,
    authorization_token: s.token,
  }));
  const toolsets = servers.map(s => ({ type: 'mcp_toolset', mcp_server_name: s.name }));
  // Subagent handoffs are plain client-defined function tools alongside the
  // managed-MCP toolsets above — Anthropic supports mixing both in one
  // `tools` array. No input needed; selecting one IS the whole signal.
  const handoffToolDefs = handoffTools.map(h => ({
    name: h.name,
    description: h.description,
    input_schema: { type: 'object', properties: {}, required: [] },
  }));

  // The mcp-client-2025-11-20 beta currently rejects both `tool_configuration`
  // on the server entry and `allowed_tools` on the toolset, so hard tool
  // filtering isn't possible for Claude yet. We enforce softly through the
  // system prompt and log so it's visible.
  const restricted = servers.filter(s => s.allowedTools.length > 0);
  let restrictionPrompt = '';
  if (restricted.length > 0) {
    restrictionPrompt = '\n\nTOOL RESTRICTIONS (enforced policy — never call tools outside these lists):' +
      restricted.map(s => `\n• ${s.name}: only ${s.allowedTools.join(', ')}`).join('');
    logger.warn({
      servers: restricted.map(s => ({ name: s.name, allowedToolCount: s.allowedTools.length })),
    }, 'claude_adapter_allowed_tools_soft_enforced');
  }

  const baseBody = {
    model,
    max_tokens: 8_000,
    system:     systemPrompt + restrictionPrompt,
    mcp_servers: mcpServers,
    tools:       [...toolsets, ...handoffToolDefs],
  };

  logger.info({
    orgId: req.context.orgId,
    model,
    historyLen: messages.length,
    mcpServerCount: servers.length,
    mcpServers: servers.map(s => s.name),
  }, 'claude_adapter_request');

  const debugRequests:  unknown[] = [];
  const debugResponses: unknown[] = [];

  const t0 = Date.now();
  let json = await callAnthropic(baseBody, messages, apiKey);
  let tokensIn  = json.usage?.input_tokens  ?? 0;
  let tokensOut = json.usage?.output_tokens ?? 0;
  if (req.debugMode) {
    debugRequests.push(redactDebugRequest({ ...baseBody, messages }));
    debugResponses.push(json);
  }

  // Subagent handoff — checked BEFORE the narration-only guard below, since
  // a handoff selection is a valid, complete turn on its own (there is no
  // "real closing reply" to wait for at THIS level; chat-engine.ts is about
  // to make a second call as the subagent's own turn). assistantText is
  // discarded (it's routing narration, not meant for the user) but any
  // mcp_tool_use calls the model ALREADY made earlier in this SAME response
  // (e.g. "let me check your account" → looks something up → THEN decides
  // to hand off) are real, already-executed actions against live Salesforce
  // data — extracted and returned here rather than silently dropped, same
  // policyViolations check as the normal path below.
  if (handoffTools.length > 0) {
    const handoffUse = (json.content ?? []).find(
      b => b.type === 'tool_use' && handoffTools.some(h => h.name === b.name),
    );
    if (handoffUse) {
      const matched = handoffTools.find(h => h.name === handoffUse.name)!;
      logger.info({ orgId: req.context.orgId, subagentNodeId: matched.subagentNodeId }, 'claude_adapter_subagent_handoff');
      const { toolCalls, policyViolations } = extractToolCallsAndViolations(json.content ?? [], servers, req.context.orgId);
      return {
        status: 'complete',
        assistantText: '',
        toolCalls,
        modelUsed: model,
        tokensIn,
        tokensOut,
        policyViolations: policyViolations.length > 0 ? policyViolations : undefined,
        handoffSubagentNodeId: matched.subagentNodeId,
        debugRequest:  req.debugMode ? debugRequests  : undefined,
        debugResponse: req.debugMode ? debugResponses : undefined,
      };
    }
  }

  // Structural (not heuristic) narration-only guard: if the response's last
  // content block isn't text, the model stopped mid-tool-use and never gave
  // a real closing reply — the system-prompt instruction reduces this but
  // doesn't eliminate it (confirmed live). One bounded continuation call
  // forces a real final answer instead of shipping "let me check that" to
  // the user.
  const content = json.content ?? [];
  const lastBlock = content[content.length - 1];
  const endsWithText = content.length > 0 && lastBlock?.type === 'text' &&
    typeof lastBlock.text === 'string' && lastBlock.text.trim().length > 0;
  if (content.length > 0 && !endsWithText) {
    logger.warn({ orgId: req.context.orgId }, 'claude_adapter_narration_only_continuation');
    const continuationMessages = [
      ...messages,
      { role: 'assistant' as const, content },
      { role: 'user' as const, content: 'Continue — that was not a complete reply, the customer cannot see it. Finish responding now with a real answer based on what you just found or did.' },
    ];
    const json2 = await callAnthropic(baseBody, continuationMessages, apiKey);
    tokensIn  += json2.usage?.input_tokens  ?? 0;
    tokensOut += json2.usage?.output_tokens ?? 0;
    if (req.debugMode) {
      debugRequests.push(redactDebugRequest({ ...baseBody, messages: continuationMessages }));
      debugResponses.push(json2);
    }
    // Merge: keep the original narration + tool calls for the transcript,
    // but the continuation's content is what actually has the closing text.
    json = { ...json2, content: [...content, ...(json2.content ?? [])] };
  }

  if (json.error) {
    logger.error({ err: json.error }, 'claude_adapter_error');
    throw new Error(json.error.message ?? 'Anthropic API error');
  }

  logger.info({
    orgId: req.context.orgId,
    tokensIn,
    tokensOut,
    ms: Date.now() - t0,
  }, 'claude_adapter_response');

  // Extract final assistant text + tool call summaries
  const assistantText = (json.content ?? [])
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n')
    .trim();

  const { toolCalls, policyViolations } = extractToolCallsAndViolations(json.content ?? [], servers, req.context.orgId);

  return {
    status: 'complete',
    assistantText,
    toolCalls,
    modelUsed: model,
    tokensIn,
    tokensOut,
    policyViolations: policyViolations.length > 0 ? policyViolations : undefined,
    debugRequest:  req.debugMode ? debugRequests  : undefined,
    debugResponse: req.debugMode ? debugResponses : undefined,
  };
}

/** Debug logging is opt-in per agent, but mcp_servers[].authorization_token is a
 *  live Salesforce access token — never let it land in a readable field. */
function redactDebugRequest(body: Record<string, unknown>): Record<string, unknown> {
  const mcpServers = body.mcp_servers;
  if (!Array.isArray(mcpServers)) return body;
  return {
    ...body,
    mcp_servers: mcpServers.map(s => ({ ...s, authorization_token: '[redacted]' })),
  };
}

async function callAnthropic(
  baseBody: Record<string, unknown>,
  messages: Array<{ role: string; content: unknown }>,
  apiKey: string,
): Promise<AnthropicResponse> {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta':    ANTHROPIC_BETA,
    },
    body: JSON.stringify({ ...baseBody, messages }),
  });
  const json = (await res.json()) as AnthropicResponse;
  if (!res.ok && !json.error) {
    throw new Error(`Anthropic API error ${res.status}`);
  }
  return json;
}

/** Convert our history + new user message (+ attachments) to Anthropic's messages array. */
function mapHistoryForClaude(
  history: ChatHistoryMessage[],
  newUserMessage: string,
  attachments: LoadedAttachment[] = [],
): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  const out: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
  for (const m of history) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: m.content });
      continue;
    }
    // tool-role messages are absorbed as continuation blocks in the prior assistant turn.
  }

  // Build the new user message. If there are attachments, use content blocks;
  // otherwise stay with the plain string form Claude prefers.
  if (attachments.length === 0) {
    out.push({ role: 'user', content: newUserMessage });
    return out;
  }

  const blocks: Array<Record<string, unknown>> = [];
  if (newUserMessage && newUserMessage.trim().length > 0) {
    blocks.push({ type: 'text', text: newUserMessage });
  }
  for (const att of attachments) {
    if (att.kind === 'image') {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: att.mimeType, data: att.base64 },
      });
    } else if (att.kind === 'pdf') {
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: att.base64 },
        title: att.fileName,
      });
    } else if (att.kind === 'text') {
      // Decode and inline as text — cheaper than shipping as a document.
      const decoded = Buffer.from(att.base64, 'base64').toString('utf8');
      blocks.push({
        type: 'text',
        text: `[Attached file: ${att.fileName}]\n\`\`\`\n${decoded}\n\`\`\``,
      });
    } else {
      blocks.push({
        type: 'text',
        text: `[Attached file: ${att.fileName} — unsupported type, skipped]`,
      });
    }
  }
  // Claude requires at least one block; guarantee text presence.
  if (blocks.length === 0 || !blocks.some(b => b.type === 'text' || b.type === 'image' || b.type === 'document')) {
    blocks.push({ type: 'text', text: newUserMessage || '(no message)' });
  }
  out.push({ role: 'user', content: blocks });
  return out;
}
