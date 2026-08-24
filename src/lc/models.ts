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

export function buildChatModel(
  nodeSubType: string,
  nodeModel: string | undefined,
  engineOverride: EngineOverride | null | undefined,
  maxTokens = 8_000,
): BuiltModel {
  const engineType = engineTypeForSubtype(nodeSubType);
  const creds = resolveEngine(engineType, engineOverride);
  const modelName = creds.defaultModel || nodeModel || DEFAULT_MODELS[engineType];

  let model: BaseChatModel;
  switch (engineType) {
    case 'openai':
      model = new ChatOpenAI({
        model: modelName,
        apiKey: creds.apiKey,
        maxTokens,
        configuration: creds.endpoint ? { baseURL: creds.endpoint.replace(/\/+$/, '') + '/v1' } : undefined,
      });
      break;
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
