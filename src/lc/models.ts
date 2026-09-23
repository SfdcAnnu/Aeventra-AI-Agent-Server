/**
 * LangChain chat-model factory — the replica's replacement for the two
 * hand-rolled provider adapters' request/wire-format code. Every provider
 * implements BaseChatModel (.invoke / .bindTools / usage_metadata), so the
 * graph runtime never knows which vendor it is talking to.
 *
 * Credential policy is unchanged from the original server: keys come ONLY
 * from Apex's per-turn engineOverride (see chat/engine-resolver.ts — no
 * server-side .env fallback, ever).
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { resolveEngine, type EngineOverride } from '../chat/engine-resolver';

const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o',
  claude: 'claude-sonnet-4-6',
  gemini: 'gemini-2.5-pro',
};

/** OpenAI's reasoning-era models (o-series, gpt-5 and later) reject the
 *  legacy `max_tokens` parameter and require `max_completion_tokens`.
 *  Live-confirmed: "Unsupported parameter: 'max_tokens' is not supported
 *  with this model" from gpt-5.5. Detect by name so a newly-released
 *  model an admin enables does not break every agent in the org. */
const NEEDS_MAX_COMPLETION_TOKENS = /^(o[1-9]|gpt-5|gpt-[6-9])/i;

/** OpenAI's `-pro` tier (gpt-5-pro, gpt-5.5-pro, o1-pro, o3-pro) is served
 *  ONLY by the Responses API. Sent to /v1/chat/completions it answers
 *  404 "This is not a chat model and thus not supported in the
 *  v1/chat/completions endpoint" — live-confirmed on gpt-5.5-pro, which
 *  took down a production agent the moment the node's own model started
 *  winning over the connection default. Detect by name so a future -pro
 *  release works without a code change. */
const RESPONSES_API_ONLY = /-pro(-|$)/i;

/** Node subtypes use canvas vocabulary ('gpt4'); engine connections use
 *  admin vocabulary ('openai') — same normalization Apex applies. */
export function engineTypeForSubtype(nodeSubType: string): 'openai' | 'claude' | 'gemini' {
  if (nodeSubType === 'gpt4' || nodeSubType === 'openai' || nodeSubType === 'custom') return 'openai';
  if (nodeSubType === 'gemini') return 'gemini';
  return 'claude';
}

export interface BuiltModel {
  model: BaseChatModel;
  modelName: string;
  engineType: 'openai' | 'claude' | 'gemini';
}

export interface ModelOptions {
  /** Force a JSON object response (OpenAI json_object mode). */
  jsonMode?: boolean;
  /** How much a reasoning-era model may think before answering. Ignored
   *  by models that do not reason. */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  /** Sampling temperature. Omit for the provider default.
   *  NOT sent to reasoning-era OpenAI models — they accept only the
   *  default and reject any explicit value. */
  temperature?: number;
}

/** The root node's "Answer style" control. Sampling temperature is what it
 *  actually means; balanced leaves the provider default alone so existing
 *  agents keep behaving exactly as they did. */
const TEMPERATURE_FOR_STYLE: Record<string, number | undefined> = {
  precise: 0.2,
  balanced: undefined,
  exploratory: 0.9,
};

/** The root node's "Thinking effort" control. `standard` maps to undefined
 *  on purpose — the provider's own default, i.e. today's behaviour — so
 *  turning this into a live control cannot silently move anyone's bill. */
const EFFORT_FOR_THINKING: Record<string, 'minimal' | 'low' | 'medium' | 'high' | undefined> = {
  off: 'minimal',
  // The seeded specs offer 'light' (system-agents.ts) and it mapped to
  // nothing here, so a specialist marked light reasoned at the provider's
  // default: the Platform Inspector spent 5,084 output tokens answering
  // which agent is used most. Low is the honest reading of light.
  light: 'low',
  standard: undefined,
  deep: 'high',
};

/**
 * Translate an AI/subagent node's inspector settings into provider options.
 *
 * These three controls (Answer style, Thinking effort, Longest reply) were
 * written to ConfigJson by the builder and the Architect but never read by
 * the runtime — the panel offered settings that did nothing. This is what
 * makes them real.
 */
export function modelOptionsFromConfig(config: unknown): { options: ModelOptions; maxTokens?: number } {
  const cfg = (config ?? {}) as {
    answerStyle?: string;
    thinkingEffort?: string;
    maxReplyTokens?: unknown;
  };
  const options: ModelOptions = {};
  if (cfg.answerStyle && cfg.answerStyle in TEMPERATURE_FOR_STYLE) {
    const t = TEMPERATURE_FOR_STYLE[cfg.answerStyle];
    if (t !== undefined) options.temperature = t;
  }
  if (cfg.thinkingEffort && cfg.thinkingEffort in EFFORT_FOR_THINKING) {
    const e = EFFORT_FOR_THINKING[cfg.thinkingEffort];
    if (e !== undefined) options.reasoningEffort = e;
  }
  const cap = Number(cfg.maxReplyTokens);
  return {
    options,
    maxTokens: Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : undefined,
  };
}

/**
 * How much room a reasoning model needs for thinking, ON TOP of the answer.
 *
 * This used to be a flat 4,000 for every effort level, which is roughly
 * right for the default and badly wrong for `high`: a high-effort model
 * reasons for as long as it is allowed, and since the cap covers thinking
 * AND the reply, it spent the entire allowance thinking and returned empty
 * content. Live: the Architect's Flow Designer, at tier large and deep
 * effort, with 8,000 requested — every one of the 12,000 tokens went to
 * reasoning, the build died on an empty response, and the customer was
 * charged large-tier output rates for nothing.
 *
 * Headroom now scales with how hard the model was told to think.
 */
function reasoningHeadroom(effort: ModelOptions['reasoningEffort']): number {
  switch (effort) {
    case 'minimal': return 2_000;
    case 'low':     return 4_000;
    case 'high':    return 20_000;
    // 'medium' and the provider default both reason more than the old flat
    // allowance assumed.
    default:        return 10_000;
  }
}

export function buildChatModel(
  nodeSubType: string,
  nodeModel: string | undefined,
  engineOverride: EngineOverride | null | undefined,
  maxTokens = 8_000,
  options: ModelOptions = {},
): BuiltModel {
  const engineType = engineTypeForSubtype(nodeSubType);
  const creds = resolveEngine(engineType, engineOverride);
  // The node's own choice wins. The connection's DefaultModel__c is the
  // fallback for nodes that never picked one — it used to take precedence,
  // which silently overrode the canvas: a node set to gpt-5.5-pro ran on
  // whatever the key's default said, making the model picker decorative.
  const modelName = nodeModel || creds.defaultModel || DEFAULT_MODELS[engineType];

  let model: BaseChatModel;
  switch (engineType) {
    case 'openai': {
      const reasoningEra = NEEDS_MAX_COMPLETION_TOKENS.test(modelName);

      // The Responses API path. Two kinds of node take it:
      //  - -pro models, which chat-completions does not serve at all;
      //  - reasoning-era models with an explicit effort (Thinking: Deep or
      //    Off). OpenAI stopped accepting `reasoning_effort` together with
      //    function tools on /v1/chat/completions — live: the Metadata
      //    Expert's Flow Specialist (gpt-5.5, Deep) failed with 400
      //    "Function tools with reasoning_effort are not supported for
      //    gpt-5.5 in /v1/chat/completions. To use function tools, use
      //    /v1/responses". Every node here may be handed tools, so the
      //    effort goes through the endpoint that accepts both.
      // Chat-completions kwargs (max_completion_tokens, response_format)
      // would be rejected by /v1/responses, so this path builds its own:
      // the reasoning block and the JSON format go in as raw Responses
      // params, because the library only recognises o-series names as
      // reasoning models and would silently drop `reasoningEffort` for
      // gpt-5.x (its isReasoningModel is /^o\d/).
      if (RESPONSES_API_ONLY.test(modelName) || (reasoningEra && options.reasoningEffort)) {
        const responsesKwargs: Record<string, unknown> = {};
        if (options.reasoningEffort) responsesKwargs.reasoning = { effort: options.reasoningEffort };
        if (options.jsonMode) responsesKwargs.text = { format: { type: 'json_object' } };
        model = new ChatOpenAI({
          model: modelName,
          apiKey: creds.apiKey,
          useResponsesApi: true,
          // Reasoning shares this budget with the visible answer, same as
          // the chat-completions reasoning path — give thinking headroom.
          maxTokens: maxTokens + reasoningHeadroom(options.reasoningEffort),
          ...(Object.keys(responsesKwargs).length > 0 ? { modelKwargs: responsesKwargs } : {}),
          configuration: creds.endpoint ? { baseURL: creds.endpoint.replace(/\/+$/, '') + '/v1' } : undefined,
        });
        break;
      }

      const kwargs: Record<string, unknown> = {};
      if (reasoningEra) {
        // max_completion_tokens covers REASONING PLUS the visible answer on
        // these models, so a cap sized for the answer alone can be spent
        // entirely on thinking and return empty content (live-confirmed on
        // gpt-5.5: the Flow Designer came back with nothing). Give the
        // thinking its own headroom on top of the caller's cap.
        // No reasoning_effort here: a reasoning-era node with an explicit
        // effort took the Responses path above.
        kwargs.max_completion_tokens = maxTokens + reasoningHeadroom(options.reasoningEffort);
      }
      if (options.jsonMode) kwargs.response_format = { type: 'json_object' };
      model = new ChatOpenAI({
        model: modelName,
        apiKey: creds.apiKey,
        ...(reasoningEra ? {} : { maxTokens }),
        // Reasoning-era models accept only the default temperature and
        // reject any explicit value, so Answer style applies to the rest.
        ...(!reasoningEra && options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(Object.keys(kwargs).length > 0 ? { modelKwargs: kwargs } : {}),
        configuration: creds.endpoint ? { baseURL: creds.endpoint.replace(/\/+$/, '') + '/v1' } : undefined,
      });
      break;
    }
    case 'claude':
      model = new ChatAnthropic({
        model: modelName,
        apiKey: creds.apiKey,
        maxTokens,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(creds.endpoint ? { anthropicApiUrl: creds.endpoint } : {}),
      });
      break;
    case 'gemini':
      model = new ChatGoogleGenerativeAI({
        model: modelName,
        apiKey: creds.apiKey,
        maxOutputTokens: maxTokens,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(creds.endpoint ? { baseUrl: creds.endpoint } : {}),
      });
      break;
  }
  return { model, modelName, engineType };
}
