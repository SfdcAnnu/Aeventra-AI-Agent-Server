/**
 * Headless AI step — a flow's AI node runs on THE SAME RUNTIME AS CHAT.
 *
 * "Headless" = no chat history, no session: one synthetic user turn built
 * from the trigger record + upstream node outputs.
 *
 * IT DID NOT USED TO BE THE SAME RUNTIME, AND THAT WAS THE BUG. This file
 * called runClaudeAdapter / runOpenAiAdapter, which hand the tool loop to
 * the model provider: `mcp_servers` on Anthropic, and on OpenAI
 * `require_approval: 'never'`, in those words. The provider received the
 * MCP URL and the org's Salesforce token and ran the tools itself. So an
 * agent whose delete tool was ticked REQUIRES APPROVAL showed an approval
 * card in chat and deleted the record with no prompt when a Flow ran it —
 * same agent, same AgentNode__c, same requiresApproval flag, read by code
 * only the chat path executed.
 *
 * Everything that makes a write safe lives in the runtime, not in the
 * agent record: the approval gate, the tool allow-list, the turn budget,
 * the loop detector, and tool arguments in THIS server's logs rather than
 * inside the provider. Routing here is what applies them to automation.
 *
 * chat-engine.ts always said this was the intent — "every caller
 * (ws/gateway.ts, chat/headless.ts) is untouched: same runChatTurn
 * signature" — and the ChatTurnRequest below was already the right shape.
 * Only the call at the bottom was wrong.
 */
import type { AgentNode } from '../types';
import type { ExecutionContext } from '../orchestrator/context';
import { runChatTurn } from './chat-engine';
import { buildConnectorInputsFromAgent } from './adapters/connectors-from-agent';
import type { ChatTurnRequest, ChatTurnResult } from './adapters/types';

const SCORE_TAIL_INSTRUCTION =
  '\n\nWhen you are done, end your reply with exactly one JSON line (no code fence) summarizing the outcome:\n' +
  '{"score": <0-100 integer, or null if not applicable>, "priority": "Hot"|"Warm"|"Cold"|null}';

export async function runHeadlessAiStep(
  ctx: ExecutionContext,
  aiNode: AgentNode,
): Promise<ChatTurnResult> {
  const connectors = await buildConnectorInputsFromAgent(ctx.agent, aiNode, ctx.conn);

  const config = (aiNode.config as { instruction?: string }) ?? {};
  const instruction = ctx.interpolate(config.instruction || '').trim();
  const contextBlock = buildContextBlock(ctx);
  const newUserMessage =
    (instruction
      ? `${instruction}\n\nContext:\n${contextBlock}`
      : `Decide what to do based on the context.\n\nContext:\n${contextBlock}`) +
    SCORE_TAIL_INSTRUCTION;

  const req: ChatTurnRequest = {
    agent: ctx.agent,
    // The node the walker arrived at, not whichever ai node happens to be
    // first on the canvas.
    aiNodeId: aiNode.id,
    sessionId: `run-${ctx.correlationId}`,
    history: [],
    newUserMessage,
    engineOverride: ctx.engineOverride,
    connectors,
    context: {
      orgId: ctx.orgId,
      userId: ctx.userId,
      recordContextId: ctx.recordId,
      recordContextType: null,
    },
  };

  // No switch on nodeSubType any more. The old adapters had one because
  // each provider's Managed MCP was its own integration, which is also why
  // Gemini threw here while working perfectly well in chat. The runtime
  // binds the same tools to any provider, so the node's own model config
  // decides and every engine the builder offers works from a trigger.
  return runChatTurn(req);
}

/** Best-effort extraction of the {score, priority} tail the model was asked to append. */
export function parseScoreTail(text: string): { score?: number; priority?: string; cleanText: string } {
  const lines = text.trim().split('\n');
  const lastLine = lines[lines.length - 1]?.trim() ?? '';
  const match = lastLine.match(/\{[^{}]*"score"[^{}]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { score?: number | null; priority?: string | null };
      const cleanText = lines.slice(0, -1).join('\n').trim() || text;
      return {
        score: typeof parsed.score === 'number' ? parsed.score : undefined,
        priority: typeof parsed.priority === 'string' ? parsed.priority : undefined,
        cleanText,
      };
    } catch { /* fall through to regex */ }
  }
  // Regex fallback — pull a 0-100 number and a Hot/Warm/Cold word if present anywhere.
  const scoreMatch = text.match(/\bscore["\s:]+(\d{1,3})\b/i);
  const priorityMatch = text.match(/\b(Hot|Warm|Cold)\b/i);
  return {
    score: scoreMatch ? Math.min(100, Number(scoreMatch[1])) : undefined,
    priority: priorityMatch ? priorityMatch[1] : undefined,
    cleanText: text,
  };
}

function buildContextBlock(ctx: ExecutionContext): string {
  const parts: string[] = [];
  parts.push(`Trigger record ID: ${ctx.recordId}`);
  if (Object.keys(ctx.inputPayload).length > 0) {
    parts.push(`Trigger payload:\n${JSON.stringify(ctx.inputPayload, null, 2)}`);
  }
  if (ctx.state.size > 0) {
    const upstream: Record<string, unknown> = {};
    for (const [nodeId, out] of ctx.state.entries()) upstream[nodeId] = out;
    parts.push(`Upstream node outputs:\n${JSON.stringify(upstream, null, 2).slice(0, 4000)}`);
  }
  return parts.join('\n\n');
}
