import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config';
import { logger } from '../../logger';

/**
 * `anthropic` MCP server — Claude integration with prompt caching.
 *
 * Caching strategy:
 *   The agent's KnowledgeBase__c (admin-authored, large, identical across requests
 *   for the same agent) is placed at the front of `system` with cache_control.
 *   Per-request system prompt and user message go after the breakpoint.
 *
 *   This means: first run on a given agent writes the cache (~1.25x cost);
 *   every subsequent run reads it (~0.1x cost on that prefix).
 *
 *   Anti-patterns that break the cache:
 *     - timestamps / per-request IDs inside `system`
 *     - re-ordering tools (none used here for now)
 *     - switching the model string mid-conversation
 */

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (_client) return _client;
  if (!config.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set — required for claude nodes');
  }
  _client = new Anthropic({ apiKey: config.anthropic.apiKey });
  return _client;
}

export interface ClaudeCallArgs {
  model: string;
  systemPrompt: string;
  knowledgeBase?: string;
  userMessage: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  adaptiveThinking?: boolean;
  maxTokens?: number;
}

export interface ClaudeCallResult {
  text: string;
  score?: number;
  priority?: 'Hot' | 'Warm' | 'Cold' | string;
  reason?: string;
  toolsUsed?: string[];
  cacheHits: { read: number; created: number };
}

export async function callClaude(args: ClaudeCallArgs): Promise<ClaudeCallResult> {
  const client = getClient();

  // Build system blocks: knowledge base first (cached), per-request prompt after.
  const systemBlocks: Anthropic.Messages.TextBlockParam[] = [];

  if (args.knowledgeBase && args.knowledgeBase.trim().length > 0) {
    systemBlocks.push({
      type: 'text',
      text: 'KNOWLEDGE BASE — Business rules and context for this agent:\n\n' + args.knowledgeBase,
      cache_control: { type: 'ephemeral' },
    });
  }

  // Default system prompt nudges the model toward JSON scoring output.
  const userSystem =
    args.systemPrompt && args.systemPrompt.trim().length > 0
      ? args.systemPrompt
      : 'You are a Salesforce AI agent. Score the record, set priority, explain your reasoning. Reply with strict JSON only.';

  systemBlocks.push({ type: 'text', text: userSystem });

  // Build request — strip thinking / effort on models that don't support them.
  const isOpus47 = args.model === 'claude-opus-4-7';
  const supportsEffort = ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6'].includes(args.model);
  const isHaiku = args.model.startsWith('claude-haiku-');

  const requestBody: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model: args.model,
    max_tokens: Math.min(args.maxTokens ?? 16000, isHaiku ? 64000 : 64000),
    system: systemBlocks,
    messages: [{ role: 'user', content: args.userMessage }],
  };

  if (args.adaptiveThinking !== false && !isHaiku) {
    requestBody.thinking = { type: 'adaptive' };
  }
  if (supportsEffort) {
    (requestBody as unknown as Record<string, unknown>).output_config = { effort: args.effort ?? 'high' };
  }
  // Opus 4.7 rejects temperature/top_p; we never set them.

  try {
    const response = await client.messages.create(requestBody);

    // Concatenate text blocks
    const text = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const parsed = tryParseScoring(text);

    logger.info(
      {
        model: args.model,
        cache_read: response.usage.cache_read_input_tokens,
        cache_creation: response.usage.cache_creation_input_tokens,
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
      },
      'claude_call_complete',
    );

    return {
      text,
      score: parsed.score,
      priority: parsed.priority,
      reason: parsed.reason ?? text.slice(0, 500),
      toolsUsed: [`anthropic:${args.model}`],
      cacheHits: {
        read: response.usage.cache_read_input_tokens ?? 0,
        created: response.usage.cache_creation_input_tokens ?? 0,
      },
    };
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      logger.error({ status: err.status, message: err.message, type: err.type }, 'anthropic_api_error');
    }
    throw err;
  }
  // isOpus47 is checked for future-proofing — currently same request shape works.
  void isOpus47;
}

/**
 * Parse the agent's JSON reply. We accept either a raw JSON object or a
 * fenced ```json ... ``` block. Anything we can't parse, we surface as text.
 */
function tryParseScoring(text: string): { score?: number; priority?: string; reason?: string } {
  // Try fenced block first
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  const candidate = fenced ? fenced[1] : text;
  // Find the first {...} substring
  const objMatch = candidate.match(/\{[\s\S]*\}/);
  if (!objMatch) return {};
  try {
    const obj = JSON.parse(objMatch[0]) as { score?: number; priority?: string; reason?: string };
    return {
      score: typeof obj.score === 'number' ? obj.score : Number(obj.score) || undefined,
      priority: obj.priority,
      reason: obj.reason,
    };
  } catch {
    return {};
  }
}
