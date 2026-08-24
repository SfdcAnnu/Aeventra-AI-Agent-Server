import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from '../../logger';

/**
 * Google Gemini integration — gemini-2.5-pro, gemini-2.5-flash, gemini-2.0-flash.
 *
 * The API key is always the caller's own AI Engine Connection (resolved via
 * chat/engine-resolver.ts, same as claude/openai) — no shared server-side
 * key, and no process-global client cache, since different orgs/users bring
 * different keys.
 *
 * Caching: Gemini supports explicit context caching via the CachedContent API,
 * but it requires a separate create-cache call and a 5+ minute TTL. For agent
 * runs (which fire ad-hoc and can be minutes apart), the overhead usually
 * outweighs the benefit. We use the standard generateContent path and let
 * customers wire CachedContent themselves for high-volume agents (TODO).
 */

export interface GeminiCallArgs {
  apiKey: string;
  model: string;
  systemPrompt: string;
  knowledgeBase?: string;
  userMessage: string;
  temperature?: number;
  maxTokens?: number;
}

export interface GeminiCallResult {
  text: string;
  score?: number;
  priority?: string;
  reason?: string;
  toolsUsed?: string[];
}

export async function callGemini(args: GeminiCallArgs): Promise<GeminiCallResult> {
  const client = new GoogleGenerativeAI(args.apiKey);

  const systemParts: string[] = [];
  if (args.knowledgeBase && args.knowledgeBase.trim().length > 0) {
    systemParts.push('KNOWLEDGE BASE — Business rules and context for this agent:\n\n' + args.knowledgeBase);
  }
  systemParts.push(
    args.systemPrompt && args.systemPrompt.trim().length > 0
      ? args.systemPrompt
      : 'You are a Salesforce AI agent. Score the record, set priority, explain your reasoning. Reply with strict JSON only.',
  );

  const model = client.getGenerativeModel({
    model: args.model,
    systemInstruction: systemParts.join('\n\n'),
    generationConfig: {
      temperature: args.temperature ?? 0.3,
      maxOutputTokens: Math.min(args.maxTokens ?? 4000, 8192),
      responseMimeType: 'text/plain',
    },
  });

  try {
    const result = await model.generateContent(args.userMessage);
    const text = result.response.text();
    const parsed = tryParseScoring(text);

    const usage = result.response.usageMetadata;
    logger.info(
      {
        model: args.model,
        prompt_tokens: usage?.promptTokenCount,
        completion_tokens: usage?.candidatesTokenCount,
        cached_tokens: usage?.cachedContentTokenCount ?? 0,
      },
      'gemini_call_complete',
    );

    return {
      text,
      score: parsed.score,
      priority: parsed.priority,
      reason: parsed.reason ?? text.slice(0, 500),
      toolsUsed: [`gemini:${args.model}`],
    };
  } catch (err) {
    logger.error({ err, model: args.model }, 'gemini_api_error');
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
