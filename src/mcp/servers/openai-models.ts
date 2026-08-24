import OpenAI from 'openai';
import { config } from '../../config';
import { logger } from '../../logger';

/**
 * OpenAI integration — gpt-4o, gpt-4o-mini, gpt-4-turbo.
 *
 * Prompt caching is **automatic** on OpenAI for prompts >1024 tokens —
 * the API detects identical prefixes and bills cached tokens at ~50%
 * (no explicit `cache_control` markers needed). We just need to put
 * stable content (knowledge base) at the start of the system message.
 *
 * See https://platform.openai.com/docs/guides/prompt-caching
 */

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (_client) return _client;
  if (!config.openai.apiKey) {
    throw new Error('OPENAI_API_KEY not set — required for gpt-4 nodes');
  }
  _client = new OpenAI({ apiKey: config.openai.apiKey });
  return _client;
}

export interface OpenAiCallArgs {
  model: string;
  systemPrompt: string;
  knowledgeBase?: string;
  userMessage: string;
  temperature?: number;
  maxTokens?: number;
}

export interface OpenAiCallResult {
  text: string;
  score?: number;
  priority?: string;
  reason?: string;
  toolsUsed?: string[];
  cacheHits: { cached: number; total: number };
}

export async function callOpenAi(args: OpenAiCallArgs): Promise<OpenAiCallResult> {
  const client = getClient();

  // Stable content first (KB), variable content after — enables automatic caching.
  const systemParts: string[] = [];
  if (args.knowledgeBase && args.knowledgeBase.trim().length > 0) {
    systemParts.push('KNOWLEDGE BASE — Business rules and context for this agent:\n\n' + args.knowledgeBase);
  }
  systemParts.push(
    args.systemPrompt && args.systemPrompt.trim().length > 0
      ? args.systemPrompt
      : 'You are a Salesforce AI agent. Score the record, set priority, explain your reasoning. Reply with strict JSON only.',
  );

  try {
    const response = await client.chat.completions.create({
      model: args.model,
      max_tokens: Math.min(args.maxTokens ?? 4000, 16000),
      temperature: args.temperature ?? 0.3,
      messages: [
        { role: 'system', content: systemParts.join('\n\n') },
        { role: 'user', content: args.userMessage },
      ],
    });

    const text = response.choices[0]?.message.content ?? '';
    const parsed = tryParseScoring(text);

    const totalTokens = response.usage?.prompt_tokens ?? 0;
    const cachedTokens =
      (response.usage as { prompt_tokens_details?: { cached_tokens?: number } } | undefined)
        ?.prompt_tokens_details?.cached_tokens ?? 0;

    logger.info(
      {
        model: args.model,
        cached_tokens: cachedTokens,
        prompt_tokens: totalTokens,
        completion_tokens: response.usage?.completion_tokens,
      },
      'openai_call_complete',
    );

    return {
      text,
      score: parsed.score,
      priority: parsed.priority,
      reason: parsed.reason ?? text.slice(0, 500),
      toolsUsed: [`openai:${args.model}`],
      cacheHits: { cached: cachedTokens, total: totalTokens },
    };
  } catch (err) {
    if (err instanceof OpenAI.APIError) {
      logger.error({ status: err.status, message: err.message, type: err.type }, 'openai_api_error');
    }
    throw err;
  }
}

function tryParseScoring(text: string): { score?: number; priority?: string; reason?: string } {
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  const candidate = fenced ? fenced[1] : text;
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

/**
 * Tool-using chat loop. Used by the bundle node executor.
 *
 * The caller provides:
 *   - messages: full chat history so far (system + user + prior tool turns)
 *   - tools:    OpenAI function-calling tool definitions
 *   - dispatch: async function that executes a tool call and returns the result
 *
 * The loop:
 *   1. Calls chat.completions.create with tools
 *   2. If response has tool_calls → executes each via `dispatch`, appends results, repeats
 *   3. If response is text-only → returns final text + tools called
 *   4. Stops at `maxIterations` to prevent runaway loops
 *
 * Errors during tool execution are fed back to the AI as the tool result with
 * `is_error: true`-style content so the model can retry or change strategy.
 */
export interface OpenAiTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  output?: unknown;
  success: boolean;
  error?: string;
}

export interface ToolLoopResult {
  finalText: string;
  toolCalls: ToolCallRecord[];
  iterations: number;
  stoppedReason: 'completed' | 'max_iterations' | 'error';
}

export async function callOpenAiWithTools(args: {
  model: string;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  tools: OpenAiTool[];
  dispatch: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  maxIterations?: number;
}): Promise<ToolLoopResult> {
  const client = getClient();
  const maxIterations = args.maxIterations ?? 10;
  const messages = [...args.messages];
  const toolCalls: ToolCallRecord[] = [];
  let iterations = 0;
  let stoppedReason: ToolLoopResult['stoppedReason'] = 'completed';

  while (iterations < maxIterations) {
    iterations++;
    const response = await client.chat.completions.create({
      model: args.model,
      messages,
      tools: args.tools,
      tool_choice: 'auto',
    });

    const choice = response.choices[0];
    const assistantMsg = choice.message;

    // Append the assistant turn (preserves tool_calls so OpenAI can correlate)
    messages.push(assistantMsg);

    // No tool calls → we're done
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      logger.info(
        {
          model: args.model,
          iterations,
          toolCallCount: toolCalls.length,
          prompt_tokens: response.usage?.prompt_tokens,
          completion_tokens: response.usage?.completion_tokens,
        },
        'openai_tool_loop_complete',
      );
      return {
        finalText: assistantMsg.content ?? '',
        toolCalls,
        iterations,
        stoppedReason,
      };
    }

    // Execute each requested tool
    for (const tc of assistantMsg.tool_calls) {
      if (tc.type !== 'function') continue;
      const fn = tc.function;
      let parsedInput: Record<string, unknown> = {};
      try {
        parsedInput = JSON.parse(fn.arguments);
      } catch {
        parsedInput = {};
      }

      const record: ToolCallRecord = { name: fn.name, input: parsedInput, success: false };
      try {
        const output = await args.dispatch(fn.name, parsedInput);
        record.output = output;
        record.success = true;
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(output).slice(0, 30_000),
        });
      } catch (err) {
        record.success = false;
        record.error = (err as Error).message;
        // Feed error back so the AI can retry / change approach (per design choice #3)
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ error: record.error }),
        });
      }
      toolCalls.push(record);
    }
  }

  // Hit iteration cap without the model returning a text-only response
  stoppedReason = 'max_iterations';
  logger.warn({ iterations, toolCallCount: toolCalls.length }, 'openai_tool_loop_capped');
  return {
    finalText: 'Tool-use loop hit the maximum iteration limit without producing a final answer.',
    toolCalls,
    iterations,
    stoppedReason,
  };
}

/**
 * Two-tier dispatch — the AI first picks WHICH capability to use, then drills
 * into that capability's tools. Reduces per-iteration tokens at enterprise scale
 * (10+ catalogs, 30+ total tools).
 *
 * Iteration shape:
 *   - "Meta level": AI sees only `list_capabilities` + `select_capability`
 *   - "In-catalog level": AI sees the chosen catalog's tools + `switch_capability`
 *
 * The AI can `switch_capability` to return to the meta level and pick a different
 * catalog. All chain-of-thought (assistant `content` between tool calls) is
 * captured into `reasoningTrace` so admins can see WHY the AI made each pick.
 */
export interface CatalogForTwoTier {
  /** Stable identifier the AI uses to refer to this catalog (e.g. "salesforce_crm"). */
  name: string;
  /** Short, AI-readable description shown at the meta level. */
  description: string;
  /** The actual tools available inside this catalog. */
  tools: OpenAiTool[];
  /** Opaque payload — passed back to the dispatcher unchanged. Used by the caller to route to the right MCP. */
  catalogContext: Record<string, unknown>;
}

export interface ReasoningStep {
  iteration: number;
  level: 'meta' | 'in_catalog';
  activeCatalog?: string;
  text: string;
}

export interface TwoTierResult {
  finalText: string;
  toolCalls: ToolCallRecord[];
  reasoningTrace: ReasoningStep[];
  iterations: number;
  stoppedReason: 'completed' | 'max_iterations';
}

export async function runTwoTierLoop(args: {
  model: string;
  initialMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  catalogs: CatalogForTwoTier[];
  /** Called for any real tool. Receives the catalog the AI was in when it called. */
  dispatch: (catalog: CatalogForTwoTier, toolName: string, input: Record<string, unknown>) => Promise<unknown>;
  maxIterations?: number;
}): Promise<TwoTierResult> {
  const client = getClient();
  const maxIterations = args.maxIterations ?? 12;
  const messages = [...args.initialMessages];
  const toolCalls: ToolCallRecord[] = [];
  const reasoningTrace: ReasoningStep[] = [];
  let activeCatalog: CatalogForTwoTier | null = null;
  let iterations = 0;

  // Static meta-tools
  const listCapabilitiesTool: OpenAiTool = {
    type: 'function',
    function: {
      name: 'list_capabilities',
      description:
        'List the capabilities (tool catalogs) available to you. Each capability bundles related tools (e.g. Salesforce CRM, email, storage). Call this when you need to see what is available.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  };
  const selectCapabilityTool: OpenAiTool = {
    type: 'function',
    function: {
      name: 'select_capability',
      description:
        'Activate one capability so you can see its tools. You can only see tools for the active capability. Switch later with switch_capability.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'The capability name from list_capabilities.' } },
        required: ['name'],
        additionalProperties: false,
      },
    },
  };
  const switchCapabilityTool: OpenAiTool = {
    type: 'function',
    function: {
      name: 'switch_capability',
      description:
        'Return to the meta level so you can pick a different capability. Call this when the tools you need are not in the active capability.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  };

  while (iterations < maxIterations) {
    iterations++;
    const tools: OpenAiTool[] = activeCatalog
      ? [...activeCatalog.tools, switchCapabilityTool]
      : [listCapabilitiesTool, selectCapabilityTool];

    const response = await client.chat.completions.create({
      model: args.model,
      messages,
      tools,
      tool_choice: 'auto',
    });
    const assistantMsg = response.choices[0].message;
    messages.push(assistantMsg);

    // Capture chain-of-thought (assistant text content interleaved between tool calls)
    if (assistantMsg.content && assistantMsg.content.trim().length > 0) {
      reasoningTrace.push({
        iteration: iterations,
        level: activeCatalog ? 'in_catalog' : 'meta',
        activeCatalog: activeCatalog?.name,
        text: assistantMsg.content,
      });
    }

    // No tool calls → done
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      logger.info(
        { model: args.model, iterations, toolCallCount: toolCalls.length },
        'openai_two_tier_complete',
      );
      return {
        finalText: assistantMsg.content ?? '',
        toolCalls,
        reasoningTrace,
        iterations,
        stoppedReason: 'completed',
      };
    }

    for (const tc of assistantMsg.tool_calls) {
      if (tc.type !== 'function') continue;
      const fnName = tc.function.name;
      let parsedInput: Record<string, unknown> = {};
      try { parsedInput = JSON.parse(tc.function.arguments); } catch { /* empty */ }

      let toolResult: unknown;

      if (fnName === 'list_capabilities') {
        toolResult = args.catalogs.map((c) => ({
          name: c.name,
          description: c.description,
          tool_count: c.tools.length,
        }));
      } else if (fnName === 'select_capability') {
        const wanted = String(parsedInput.name);
        const found = args.catalogs.find((c) => c.name === wanted);
        if (found) {
          activeCatalog = found;
          toolResult = {
            success: true,
            active_capability: found.name,
            available_tools: found.tools.map((t) => t.function.name),
          };
        } else {
          toolResult = {
            success: false,
            error: `Unknown capability '${wanted}'. Available: ${args.catalogs.map((c) => c.name).join(', ')}`,
          };
        }
      } else if (fnName === 'switch_capability') {
        activeCatalog = null;
        toolResult = {
          success: true,
          message: 'Returned to meta level. Call list_capabilities or select_capability next.',
        };
      } else if (activeCatalog) {
        // Real tool call inside the active catalog
        const record: ToolCallRecord = { name: fnName, input: parsedInput, success: false };
        try {
          const output = await args.dispatch(activeCatalog, fnName, parsedInput);
          record.output = output;
          record.success = true;
          toolResult = output;
        } catch (err) {
          record.error = (err as Error).message;
          toolResult = { error: record.error };
        }
        toolCalls.push(record);
      } else {
        // AI tried to call a real tool while at the meta level — shouldn't happen but handle gracefully
        toolResult = {
          error: `Cannot call '${fnName}' without first activating a capability. Call select_capability first.`,
        };
      }

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(toolResult).slice(0, 30_000),
      });
    }
  }

  logger.warn({ iterations, toolCallCount: toolCalls.length }, 'openai_two_tier_capped');
  return {
    finalText: 'Tool-use loop hit the maximum iteration limit without producing a final answer.',
    toolCalls,
    reasoningTrace,
    iterations,
    stoppedReason: 'max_iterations',
  };
}
