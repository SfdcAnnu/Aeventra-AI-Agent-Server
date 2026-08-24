/**
 * Headless AI step — runs a flow's AI node through the SAME adapters chat
 * uses (runClaudeAdapter / runOpenAiAdapter), so Managed MCP tools, custom
 * Apex/Flow tools, and per-user engine credentials all behave identically
 * whether the agent is chatting or executing autonomously.
 *
 * "Headless" = no chat history, no session — one synthetic user turn built
 * from the trigger record + upstream node outputs, same shape ai.ts used
 * to hand-assemble before this replaced it.
 */
import type { AgentNode } from '../types';
import type { ExecutionContext } from '../orchestrator/context';
import { runClaudeAdapter } from './adapters/claude';
import { runOpenAiAdapter } from './adapters/openai';
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

  switch (aiNode.nodeSubType) {
    case 'claude':
      return runClaudeAdapter(req, aiNode);
    case 'gpt4':
      return runOpenAiAdapter(req, aiNode);
    default:
      throw new Error(
        `Flow AI step does not support node sub-type "${aiNode.nodeSubType}" yet — use a Claude or GPT node.`,
      );
  }
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
