/**
 * Auto session titles.
 *
 * Trigger: after turn 3, the chat-engine fires this off-thread. The user's
 * response is already returned; the title fills in a few seconds later.
 *
 * Model choice: cheapest model of whichever engine the agent is using.
 *   • Claude → claude-haiku-4-5-20251001
 *   • OpenAI → gpt-4o-mini
 *   • Gemini → gemini-2.0-flash-lite
 *
 * One API bill (same provider as the agent), minimal cost.
 *
 * Never throws. All errors are swallowed + logged. A missing title is fine;
 * a broken chat turn because of title generation is not.
 */
import { logger } from '../logger';
import type { ChatHistoryMessage } from './adapters/types';
import { resolveEngine, type EngineOverride } from './engine-resolver';
import { getOrgConnection } from '../salesforce/per-org-connection';

const TITLE_PROMPT =
  'Give a 3-6 word title for this conversation. Plain text only. ' +
  'No quotes. No emoji. No trailing punctuation. No labels like "Title:". ' +
  "Match the topic of the user's question, not the greeting.";

const CHEAP_MODEL: Record<'claude' | 'openai' | 'gemini', string> = {
  claude: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.0-flash-lite',
};

/** Regexes for greetings/politeness/affirmations that we should skip. */
const GREETING_RE = /^(hi|hello|hey|hola|greetings?|namaste|good\s?(morning|afternoon|evening|night))[\s\.\!\?,]*$/i;
const AFFIRM_RE   = /^(ok|okay|yes|no|yeah|nah|sure|cool|fine|good|great|got\s?it|understood|awesome|nice|wow)[\s\.\!\?,]*$/i;
const THANKS_RE   = /^(thanks?|thank\s?you|ty|thx|cheers|no\s+problem|welcome)[\s\.\!\?,]*$/i;
const SMALLTALK_RE= /^(how\s+are\s+you|i\s+am\s+(good|fine|ok|great)|what's\s+up|whats\s+up|sup)[\s\.\!\?,]*$/i;
const PUNCT_RE    = /^[\p{P}\p{S}\s]+$/u;

/** A message is substantive when it looks like a real question/request. */
export function isSubstantive(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < 15)      return false;
  if (GREETING_RE.test(trimmed))  return false;
  if (AFFIRM_RE.test(trimmed))    return false;
  if (THANKS_RE.test(trimmed))    return false;
  if (SMALLTALK_RE.test(trimmed)) return false;
  if (PUNCT_RE.test(trimmed))     return false;
  return true;
}

export interface GenerateTitleParams {
  orgId:              string;
  sessionId:          string;
  engineType:         'claude' | 'openai' | 'gemini';
  history:            ChatHistoryMessage[];
  newUserMessage:     string;
  newAssistantMessage: string;
  engineOverride?:    EngineOverride;
}

/** Fire-and-forget wrapper — call this after a turn returns; do not await. */
export function generateSessionTitleAsync(params: GenerateTitleParams): void {
  generateSessionTitle(params).catch(err => {
    logger.warn({ err, sessionId: params.sessionId }, 'title_generation_failed');
  });
}

async function generateSessionTitle(params: GenerateTitleParams): Promise<void> {
  const t0 = Date.now();

  // Build pool of substantive messages from history + this turn.
  const userMessages:      string[] = [];
  const assistantMessages: string[] = [];
  for (const m of params.history) {
    if (m.role === 'user' && isSubstantive(m.content)) userMessages.push(m.content);
    else if (m.role === 'assistant' && m.content) assistantMessages.push(m.content);
  }
  if (isSubstantive(params.newUserMessage)) userMessages.push(params.newUserMessage);
  if (params.newAssistantMessage) assistantMessages.push(params.newAssistantMessage);

  if (userMessages.length === 0) {
    logger.info({ sessionId: params.sessionId }, 'title_skip_no_substantive_user_msg');
    return;
  }

  const cap = (s: string) => s.length > 800 ? s.slice(0, 800) + '…' : s;
  const conversation = [
    ...userMessages.slice(0, 2).map(u => `User: ${cap(u)}`),
    ...assistantMessages.slice(0, 1).map(a => `Assistant: ${cap(a)}`),
  ].join('\n\n');

  // Resolve creds for the SAME engine as the agent.
  let apiKey: string;
  let endpoint: string | null;
  try {
    const creds = resolveEngine(params.engineType, params.engineOverride);
    apiKey   = creds.apiKey;
    endpoint = creds.endpoint;
  } catch (err) {
    logger.info({ sessionId: params.sessionId, engineType: params.engineType }, 'title_skip_no_key');
    return;
  }

  const model = CHEAP_MODEL[params.engineType];
  let title: string;
  if (params.engineType === 'claude') {
    title = await titleFromClaude(apiKey, model, conversation, endpoint);
  } else if (params.engineType === 'openai') {
    title = await titleFromOpenAi(apiKey, model, conversation, endpoint);
  } else {
    title = await titleFromGemini(apiKey, model, conversation, endpoint);
  }

  // Normalize the title text.
  title = title.trim();
  title = title.replace(/^["'`]|["'`]$/g, '');
  title = title.replace(/^Title:\s*/i, '');
  title = title.replace(/[\.\!\?,;:]+\s*$/, '');
  if (!title) return;
  if (title.length > 117) title = title.slice(0, 117);

  // Persist to Salesforce.
  const conn = await getOrgConnection(params.orgId);
  await conn.sobject('ChatSession__c').update({
    Id: params.sessionId,
    Title__c: title,
    TitleGeneratedByAi__c: true,
  });
  logger.info({
    sessionId:  params.sessionId,
    engineType: params.engineType,
    model,
    title,
    ms: Date.now() - t0,
  }, 'title_generated');
}

// ── Provider-specific title generation ─────────────────────────────────

async function titleFromClaude(apiKey: string, model: string, conversation: string, endpoint: string | null): Promise<string> {
  const url = (endpoint?.replace(/\/+$/, '') || 'https://api.anthropic.com') + '/v1/messages';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 40,
      system:     TITLE_PROMPT,
      messages:   [{ role: 'user', content: conversation }],
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Claude title call failed (${res.status}): ${errBody.slice(0, 200)}`);
  }
  const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = (json.content || [])
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join(' ')
    .trim();
  return text || '';
}

async function titleFromOpenAi(apiKey: string, model: string, conversation: string, endpoint: string | null): Promise<string> {
  const url = (endpoint?.replace(/\/+$/, '') || 'https://api.openai.com') + '/v1/responses';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: TITLE_PROMPT }] },
        { role: 'user',   content: [{ type: 'input_text', text: conversation }] },
      ],
      max_output_tokens: 30,
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`OpenAI title call failed (${res.status}): ${errBody.slice(0, 200)}`);
  }
  const json = (await res.json()) as { output_text?: string };
  return json.output_text || '';
}

async function titleFromGemini(apiKey: string, model: string, conversation: string, endpoint: string | null): Promise<string> {
  const base = endpoint?.replace(/\/+$/, '') || 'https://generativelanguage.googleapis.com';
  const modelPath = model.startsWith('models/') ? model : `models/${model}`;
  const url = `${base}/v1beta/${modelPath}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: TITLE_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: conversation }] }],
      generationConfig: { maxOutputTokens: 30, temperature: 0.5 },
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini title call failed (${res.status}): ${errBody.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = (json.candidates || [])
    .flatMap(c => c.content?.parts || [])
    .map(p => p.text || '')
    .join(' ')
    .trim();
  return text || '';
}
