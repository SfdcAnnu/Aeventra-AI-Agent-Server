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
  const modelName = creds.defaultModel || nodeModel || DEFAULT_MODELS[engineType];

  let model: BaseChatModel;
  switch (engineType) {
    case 'openai': {
      const reasoningEra = NEEDS_MAX_COMPLETION_TOKENS.test(modelName);
      const kwargs: Record<string, unknown> = {};
      if (reasoningEra) {
        // max_completion_tokens covers REASONING PLUS the visible answer on
        // these models, so a cap sized for the answer alone can be spent
        // entirely on thinking and return empty content (live-confirmed on
        // gpt-5.5: the Flow Designer came back with nothing). Give the
        // thinking its own headroom on top of the caller's cap.
        kwargs.max_completion_tokens = maxTokens + 4_000;
        if (options.reasoningEffort) kwargs.reasoning_effort = options.reasoningEffort;
      }
      if (options.jsonMode) kwargs.response_format = { type: 'json_object' };
      model = new ChatOpenAI({
        model: modelName,
        apiKey: creds.apiKey,
        ...(reasoningEra ? {} : { maxTokens }),
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
        ...(creds.endpoint ? { anthropicApiUrl: creds.endpoint } : {}),
      });
      break;
    case 'gemini':
      model = new ChatGoogleGenerativeAI({
        model: modelName,
        apiKey: creds.apiKey,
        maxOutputTokens: maxTokens,
        ...(creds.endpoint ? { baseUrl: creds.endpoint } : {}),
      });
      break;
  }
  return { model, modelName, engineType };
}
