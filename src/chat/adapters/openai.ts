/**
 * OpenAI adapter — uses OpenAI's Responses API with the MCP tool type.
 *
 * OpenAI's Responses API supports MCP servers natively (since Feb 2025).
 * Pattern is symmetrical to the Claude adapter — pass the MCP server URL
 * + SF access token, OpenAI handles the entire MCP round-trip internally.
 *
 * We use fetch directly (not the SDK) because the MCP tool type is still
 * being surfaced in the TypeScript client — cleaner to speak the JSON API
 * directly and stay future-proof.
 */
import { logger } from '../../logger';
import type { AgentNode } from '../../types';
import { InstallsRepo } from '../../db/installs.repo';
import { buildSystemPrompt, resolveMcpServers } from './shared';
import { loadAttachments, type LoadedAttachment } from './attachments';
import { resolveEngine } from '../engine-resolver';
import type { HandoffToolDef } from '../subagent-router';
import type {
  ChatHistoryMessage,
  ChatTurnRequest,
  ChatTurnResult,
  ToolCallSummary,
} from './types';

const OPENAI_URL = 'https://api.openai.com/v1/responses';

export interface OpenAiResponsesResult {
  id:     string;
  model:  string;
  output: Array<{
    type:    string;
    id?:     string;
    role?:   string;
    content?: Array<{ type: string; text?: string }>;
    // MCP tool call/result blocks
    name?:   string;
    server_label?: string;
    arguments?: unknown;
    output?:    unknown;
    error?:     unknown;
  }>;
  output_text?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string; type?: string };
}

/**
 * Shared by both the normal return path AND the subagent-handoff early
 * return — OpenAI can return already-executed mcp_call/mcp_tool_call blocks
 * in the SAME response as a function_call handoff selection, so both call
 * sites need identical extraction rather than the handoff path silently
 * discarding real, billed, already-executed actions. No policy-violation
 * concept here (unlike claude.ts) — OpenAI hard-enforces allowed_tools
 * server-side via `allowed_tools` on the mcp tool def, so an out-of-policy
 * call can't reach us in the first place.
 */
function extractOpenAiToolCalls(output: OpenAiResponsesResult['output']): ToolCallSummary[] {
  const toolCalls: ToolCallSummary[] = [];
  for (const b of output ?? []) {
    if (b.type === 'mcp_call' || b.type === 'mcp_tool_call') {
      const failed = !!b.error;
      toolCalls.push({
        id:      b.id ?? '',
        name:    b.name ?? '',
        input:   (b.arguments as Record<string, unknown>) ?? {},
        output:  failed ? `MCP call failed: ${typeof b.error === 'string' ? b.error : JSON.stringify(b.error)}` : b.output,
        isError: failed,
      });
      if (failed) {
        logger.warn({ tool: b.name, error: b.error }, 'openai_mcp_call_failed');
      }
    }
  }
  return toolCalls;
}

export async function runOpenAiAdapter(
  req: ChatTurnRequest,
  aiNode: AgentNode,
  handoffTools: HandoffToolDef[] = [],
): Promise<ChatTurnResult> {
  // Resolve credentials: per-user override from Apex → fall back to .env
  const creds = resolveEngine('openai', req.engineOverride);
  const apiKey = creds.apiKey;

  const install = await InstallsRepo.findByOrgId(req.context.orgId);
  if (!install?.sfAccessToken) {
    throw new Error('Org has no Salesforce tokens. Admin must run Synapse Setup first.');
  }

  const model        = creds.defaultModel || (aiNode.config as { model?: string })?.model || 'gpt-4o';
  const systemPrompt = await buildSystemPrompt(req.agent, aiNode, req.context, req.newUserMessage, req.engineOverride, req.memoryPreamble);
  // Attachments are opt-in — skip the whole helper (no jsforce, no SF calls)
  // when the turn has none.
  const attachments = (req.attachments && req.attachments.length > 0)
    ? await loadAttachments(req.context.orgId, req.attachments)
    : [];
  const input = mapHistoryForOpenAi(req.history, req.newUserMessage, systemPrompt, attachments);
  
  // Multi-connector: Salesforce sends connectors[] each turn; we attach the
  // right token per provider. Legacy fallback = single env-configured SF MCP.
  // OpenAI enforces allowed_tools HARD — unticked tools are invisible to the model.
  const servers = await resolveMcpServers(req, aiNode, install.sfAccessToken);
  if (servers.length === 0) {
    throw new Error('No MCP servers available for this agent. Bind a connector on the canvas, or set SF_REMOTE_MCP_URL.');
  }

  const mcpTools = servers.map(s => {
    const mcpTool: Record<string, unknown> = {
      type:             'mcp',
      server_label:     s.name,
      server_url:       s.url,
      headers:          { Authorization: 'Bearer ' + s.token },
      require_approval: 'never',
    };
    if (s.allowedTools.length > 0) mcpTool.allowed_tools = s.allowedTools;
    return mcpTool;
  });
  // Subagent handoffs are plain function tools alongside the MCP tools
  // above — the Responses API supports mixing both in one `tools` array.
  // No parameters needed; selecting one IS the whole signal.
  const handoffToolDefs = handoffTools.map(h => ({
    type: 'function',
    name: h.name,
    description: h.description,
    parameters: { type: 'object', properties: {}, required: [] },
  }));
  const tools = [...mcpTools, ...handoffToolDefs];

  const baseBody = { model, tools, max_output_tokens: 8_000 };

  logger.info({
    orgId: req.context.orgId,
    model,
    historyLen: input.length,
    mcpServerCount: servers.length,
    mcpServers: servers.map(s => ({ name: s.name, allowedToolCount: s.allowedTools.length })),
  }, 'openai_adapter_request');

  // Attachments summary (do NOT log binary/base64 contents)
  if (attachments.length > 0) {
    try {
      logger.info({ orgId: req.context.orgId, attachments: attachments.map(a => ({ fileName: a.fileName, kind: a.kind })) }, 'openai_adapter_attachments_summary');
    } catch (err) {
      logger.warn({ orgId: req.context.orgId, err }, 'openai_adapter_attachments_log_failed');
    }
  }

  const debugRequests:  unknown[] = [];
  const debugResponses: unknown[] = [];

  const t0 = Date.now();
  // Redact sensitive headers before logging the full request body
  try {
    logger.info({ orgId: req.context.orgId, openaiRequest: redactDebugRequest({ ...baseBody, input }) }, 'openai_adapter_request_full');
  } catch (err) {
    logger.warn({ orgId: req.context.orgId, err }, 'openai_adapter_redact_request_failed');
  }

  let json = await callOpenAi({ ...baseBody, input }, apiKey);
  let tokensIn  = json.usage?.input_tokens  ?? 0;
  let tokensOut = json.usage?.output_tokens ?? 0;
  if (req.debugMode) {
    debugRequests.push(redactDebugRequest({ ...baseBody, input }));
    debugResponses.push(json);
  }

  // Subagent handoff — checked BEFORE the narration-only guard below, same
  // reasoning as the Claude adapter: a handoff selection is a complete turn
  // on its own. This call's assistantText/toolCalls are discarded by the
  // caller — only token usage still counts.
  if (handoffTools.length > 0) {
    const handoffCall = (json.output ?? []).find(
      b => b.type === 'function_call' && handoffTools.some(h => h.name === b.name),
    );
    if (handoffCall) {
      const matched = handoffTools.find(h => h.name === handoffCall.name)!;
      logger.info({ orgId: req.context.orgId, subagentNodeId: matched.subagentNodeId }, 'openai_adapter_subagent_handoff');
      return {
        status: 'complete',
        assistantText: '',
        toolCalls: extractOpenAiToolCalls(json.output),
        modelUsed: model,
        tokensIn,
        tokensOut,
        handoffSubagentNodeId: matched.subagentNodeId,
        debugRequest:  req.debugMode ? debugRequests  : undefined,
        debugResponse: req.debugMode ? debugResponses : undefined,
      };
    }
  }

  // Structural (not heuristic) narration-only guard — same issue confirmed
  // in the Claude adapter: if the response doesn't end in a real assistant
  // message, the model stopped mid-tool-use without ever replying to the
  // customer. One bounded continuation forces a real final answer, using
  // the Responses API's own previous_response_id continuation instead of
  // manually replaying the conversation.
  const output = json.output ?? [];
  const lastItem = output[output.length - 1];
  const lastText = lastItem?.type === 'message' && Array.isArray(lastItem.content)
    ? lastItem.content.map(c => c.text ?? '').join('').trim()
    : '';
  const endsWithText = output.length > 0 && lastItem?.type === 'message' && lastText.length > 0;

  if (output.length > 0 && !endsWithText && json.id) {
    logger.warn({ orgId: req.context.orgId }, 'openai_adapter_narration_only_continuation');
    const continuationBody = {
      ...baseBody,
      input: [{
        role: 'user',
        content: [{
          type: 'input_text',
          text: 'Continue — that was not a complete reply, the customer cannot see it. Finish responding now with a real answer based on what you just found or did.',
        }],
      }],
      previous_response_id: json.id,
    };
    const json2 = await callOpenAi(continuationBody, apiKey);
    tokensIn  += json2.usage?.input_tokens  ?? 0;
    tokensOut += json2.usage?.output_tokens ?? 0;
    if (req.debugMode) {
      debugRequests.push(redactDebugRequest(continuationBody));
      debugResponses.push(json2);
    }
    json = { ...json2, output: [...output, ...(json2.output ?? [])] };
  }

  if (json.error) {
    logger.error({ err: json.error }, 'openai_adapter_error');
    throw new Error(json.error.message ?? 'OpenAI API error');
  }

  logger.info({
    orgId: req.context.orgId,
    tokensIn,
    tokensOut,
    ms: Date.now() - t0,
  }, 'openai_adapter_response');

  // Log the raw response (summary) we received from OpenAI
  try {
    logger.info({ orgId: req.context.orgId, responseId: json.id, responseModel: json.model, outputBlocks: (json.output ?? []).length, outputTextLen: json.output_text ? json.output_text.length : 0, usage: json.usage, error: json.error }, 'openai_adapter_raw_response');
  } catch (err) {
    logger.warn({ orgId: req.context.orgId, err }, 'openai_adapter_log_response_failed');
  }

  // Preferred: use the flattened output_text field OpenAI provides
  let assistantText = json.output_text?.trim() ?? '';
  if (!assistantText) {
    // Fallback — walk output blocks and collect any text content
    for (const b of json.output ?? []) {
      if (b.type === 'message' && Array.isArray(b.content)) {
        for (const c of b.content) if (typeof c.text === 'string') assistantText += c.text;
      }
    }
    assistantText = assistantText.trim();
  }

  const toolCalls = extractOpenAiToolCalls(json.output);

  // Log extracted tool calls and assistant preview for traceability
  try {
    logger.info({ orgId: req.context.orgId, assistantPreview: assistantText ? assistantText.slice(0, 400) : '', toolCallsCount: toolCalls.length, toolCalls }, 'openai_adapter_final');
  } catch (err) {
    logger.warn({ orgId: req.context.orgId, err }, 'openai_adapter_final_log_failed');
  }

  return {
    status: 'complete',
    assistantText,
    toolCalls,
    modelUsed: model,
    tokensIn,
    tokensOut,
    debugRequest:  req.debugMode ? debugRequests  : undefined,
    debugResponse: req.debugMode ? debugResponses : undefined,
  };
}

/** Debug logging is opt-in per agent, but tools[].headers.Authorization carries
 *  a live Salesforce access token — never let it land in a readable field. */
function redactDebugRequest(body: Record<string, unknown>): Record<string, unknown> {
  const tools = body.tools;
  if (!Array.isArray(tools)) return body;
  return {
    ...body,
    tools: tools.map(t => (t && typeof t === 'object' && 'headers' in t)
      ? { ...t, headers: { ...(t as Record<string, unknown>).headers as Record<string, unknown>, Authorization: '[redacted]' } }
      : t),
  };
}

/** Thin fetch wrapper around the Responses API — exported so callers
 *  outside the chat engine (the agent generator, the builder copilot) can
 *  reuse the exact same request/error handling without duplicating it. */
export async function callOpenAi(
  body: Record<string, unknown>,
  apiKey: string,
): Promise<OpenAiResponsesResult> {
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  'Bearer ' + apiKey,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as OpenAiResponsesResult;
  if (!res.ok && !json.error) {
    throw new Error(`OpenAI API error ${res.status}`);
  }
  return json;
}

/** Map our history + system prompt + new user message (+ attachments) → OpenAI Responses `input` array. */
function mapHistoryForOpenAi(
  history: ChatHistoryMessage[],
  newUserMessage: string,
  systemPrompt: string,
  attachments: LoadedAttachment[] = [],
): Array<{ role: string; content: Array<Record<string, unknown>> }> {
  const out: Array<{ role: string; content: Array<Record<string, unknown>> }> = [];
  out.push({ role: 'system', content: [{ type: 'input_text', text: systemPrompt }] });
  for (const m of history) {
    if (m.role === 'system' || m.role === 'tool') continue;
    out.push({
      role: m.role,
      content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content }],
    });
  }

  // Build the final user message with attachments as extra content parts.
  const finalContent: Array<Record<string, unknown>> = [];
  if (newUserMessage && newUserMessage.trim().length > 0) {
    finalContent.push({ type: 'input_text', text: newUserMessage });
  }
  for (const att of attachments) {
    if (att.kind === 'image') {
      finalContent.push({
        type:      'input_image',
        image_url: `data:${att.mimeType};base64,${att.base64}`,
      });
    } else if (att.kind === 'pdf') {
      finalContent.push({
        type:      'input_file',
        filename:  att.fileName,
        file_data: `data:application/pdf;base64,${att.base64}`,
      });
    } else if (att.kind === 'text') {
      const decoded = Buffer.from(att.base64, 'base64').toString('utf8');
      finalContent.push({
        type: 'input_text',
        text: `[Attached file: ${att.fileName}]\n\`\`\`\n${decoded}\n\`\`\``,
      });
    } else {
      finalContent.push({
        type: 'input_text',
        text: `[Attached file: ${att.fileName} — unsupported type, skipped]`,
      });
    }
  }
  if (finalContent.length === 0) {
    finalContent.push({ type: 'input_text', text: '(no message)' });
  }
  out.push({ role: 'user', content: finalContent });
  return out;
}
