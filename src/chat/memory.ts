/**
 * Conversation memory: running summary + structured facts per ChatSession__c.
 *
 * DESIGN INVARIANTS (see the Agent Memory Playbook artifact for the full
 * rationale — this file is its implementation):
 *
 *  1. ZERO added response latency. A turn only ever READS memory that a
 *     previous turn already stored; the expensive summarization call runs
 *     fire-and-forget AFTER the reply is on its way (same post-response
 *     slot the WS path already uses for persistence). A summary is thus
 *     always "one turn stale", which is harmless because of #2.
 *
 *  2. NO COVERAGE GAP, EVER. MemoryCoveredCount__c records how many leading
 *     history messages the summary covers; each turn sends
 *     summary + history[coveredCount..]. If the async job lags or fails,
 *     the raw tail is just longer — never missing.
 *
 *  3. Salesforce stays the system of record. The server holds only an
 *     in-process cache (single-instance host); a restart re-reads the
 *     fields from ChatSession__c.
 *
 *  4. Failures degrade to today's behavior. Any error here means "send the
 *     full raw history like before" — memory can never break a turn.
 */
import { getOrgConnection } from '../salesforce/per-org-connection';
import { logger } from '../logger';
import type { ChatHistoryMessage, EngineOverrideInput } from './adapters/types';

/** Raw tail longer than this (in messages, ~2 per turn) triggers an async
 *  summarize pass after the reply. 30 messages ≈ 15 turns. */
const TRIGGER_RAW_MESSAGES = Number(process.env.MEMORY_TRIGGER_MSGS ?? 30);
/** How many recent messages always stay verbatim after summarization. */
const KEEP_RAW_MESSAGES = Number(process.env.MEMORY_KEEP_MSGS ?? 16);
/** Input guardrails for the summarizer call. */
const MAX_MSG_CHARS = 600;
const MAX_TRANSCRIPT_CHARS = 16000;

export interface SessionMemory {
  summary: string | null;
  factsJson: string | null;
  coveredCount: number;
}

// Per-session cache — avoids a Salesforce read on every turn. Safe because
// this host runs a single instance; entries refresh from SF after restarts.
const memoryCache = new Map<string, SessionMemory>();
const cacheKey = (orgId: string, sessionId: string) => `${orgId}:${sessionId}`;

function looksLikeSalesforceId(value: string): boolean {
  return /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(value);
}

/** Read the session's stored memory (cached). null → no memory / not a real
 *  session (test panel) / read failed — all mean "behave exactly as before". */
export async function loadSessionMemory(orgId: string, sessionId: string): Promise<SessionMemory | null> {
  if (!looksLikeSalesforceId(sessionId)) return null;
  const key = cacheKey(orgId, sessionId);
  const cached = memoryCache.get(key);
  if (cached) return cached;
  try {
    const conn = await getOrgConnection(orgId);
    const res = await conn.query<{
      MemorySummary__c: string | null;
      MemoryFactsJson__c: string | null;
      MemoryCoveredCount__c: number | null;
    }>(
      `SELECT MemorySummary__c, MemoryFactsJson__c, MemoryCoveredCount__c FROM ChatSession__c WHERE Id = '${sessionId}' LIMIT 1`,
    );
    const rec = res.records[0];
    if (!rec) return null;
    const memory: SessionMemory = {
      summary: rec.MemorySummary__c ?? null,
      factsJson: rec.MemoryFactsJson__c ?? null,
      coveredCount: rec.MemoryCoveredCount__c ?? 0,
    };
    memoryCache.set(key, memory);
    return memory;
  } catch (err) {
    logger.warn({ orgId, sessionId, err: err instanceof Error ? err.message : err }, 'memory_load_failed');
    return null;
  }
}

/** Turn-assembly: apply the coverage invariant. Returns the history slice to
 *  actually send plus the system-prompt preamble (facts + summary blocks). */
export function assembleMemory(
  history: ChatHistoryMessage[],
  memory: SessionMemory | null,
): { history: ChatHistoryMessage[]; preamble: string | null } {
  const blocks: string[] = [];
  if (memory?.factsJson) {
    blocks.push(
      'SESSION FACTS (authoritative — always use these exact values, especially record Ids):\n' + memory.factsJson,
    );
  }
  let outHistory = history;
  if (memory?.summary && memory.coveredCount > 0 && memory.coveredCount < history.length) {
    blocks.push('CONVERSATION SO FAR (older turns, summarized):\n' + memory.summary);
    outHistory = history.slice(memory.coveredCount);
  }
  return { history: outHistory, preamble: blocks.length > 0 ? blocks.join('\n\n') : null };
}

export interface MemoryUpdateArgs {
  orgId: string;
  sessionId: string;
  /** The FULL history as received this turn (pre-slice). */
  history: ChatHistoryMessage[];
  newUserMessage: string;
  assistantText: string;
  engineOverride?: EngineOverrideInput | null;
  memory: SessionMemory | null;
}

/** Fire-and-forget, called AFTER the turn result exists — never awaited by
 *  the response path. Decides whether the raw tail has outgrown the
 *  threshold and, if so, folds it into the summary + facts with one cheap
 *  model call, then persists to ChatSession__c and refreshes the cache. */
export function maybeUpdateMemoryAsync(args: MemoryUpdateArgs): void {
  void (async () => {
    const { orgId, sessionId } = args;
    if (!looksLikeSalesforceId(sessionId)) return;
    const covered = args.memory?.coveredCount ?? 0;
    // This turn's two messages count toward the tail the NEXT turn will send.
    const totalAfterTurn = args.history.length + 2;
    const rawTail = totalAfterTurn - covered;
    if (rawTail <= TRIGGER_RAW_MESSAGES) return;

    const newCovered = totalAfterTurn - KEEP_RAW_MESSAGES;
    if (newCovered <= covered) return;

    // Transcript of exactly the span moving from "raw" to "summarized":
    // history[covered .. newCovered), where the two just-exchanged messages
    // sit at the end of the virtual array.
    const virtual: ChatHistoryMessage[] = [
      ...args.history,
      { role: 'user', content: args.newUserMessage },
      { role: 'assistant', content: args.assistantText },
    ];
    const span = virtual.slice(covered, newCovered);
    let transcript = span
      .map(m => `${m.role.toUpperCase()}: ${(m.content ?? '').slice(0, MAX_MSG_CHARS)}`)
      .join('\n');
    if (transcript.length > MAX_TRANSCRIPT_CHARS) transcript = transcript.slice(-MAX_TRANSCRIPT_CHARS);

    const result = await summarize(args.engineOverride, {
      existingSummary: args.memory?.summary ?? '',
      existingFacts: args.memory?.factsJson ?? '{}',
      transcript,
    });
    if (!result) return; // provider unavailable — retry naturally next turn

    const updated: SessionMemory = {
      summary: result.summary,
      factsJson: result.factsJson,
      coveredCount: newCovered,
    };
    try {
      const conn = await getOrgConnection(orgId);
      await conn.sobject('ChatSession__c').update({
        Id: sessionId,
        MemorySummary__c: updated.summary,
        MemoryFactsJson__c: updated.factsJson,
        MemoryCoveredCount__c: updated.coveredCount,
      });
      memoryCache.set(cacheKey(orgId, sessionId), updated);
      logger.info({ orgId, sessionId, coveredCount: newCovered, rawKept: KEEP_RAW_MESSAGES }, 'memory_updated');
    } catch (err) {
      logger.warn({ orgId, sessionId, err: err instanceof Error ? err.message : err }, 'memory_persist_failed');
    }
  })().catch(err => {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'memory_update_failed');
  });
}

// ── The one cheap model call ─────────────────────────────────────────

const SUMMARIZER_SYSTEM = `You maintain conversation memory for a Salesforce AI agent. Merge the EXISTING SUMMARY and EXISTING FACTS with the NEW TURNS.
Rules:
- summary: at most 160 words, factual, third person. Preserve every Salesforce record Id VERBATIM (never truncate ids like 006g5000009RkPzAAK). Keep decisions, amounts, objections, promises, and open questions.
- facts: a flat JSON object of durable, exact values: customer identity, verified (boolean), record ids, amounts, offers made/rejected, preferences. Merge with existing facts; never drop a record id.
Reply with ONLY this JSON, nothing else: {"summary": "...", "facts": {...}}`;

interface SummarizeInput {
  existingSummary: string;
  existingFacts: string;
  transcript: string;
}

async function summarize(
  engine: EngineOverrideInput | null | undefined,
  input: SummarizeInput,
): Promise<{ summary: string; factsJson: string } | null> {
  if (!engine?.apiKey) return null;
  const user = `EXISTING SUMMARY:\n${input.existingSummary || '(none)'}\n\nEXISTING FACTS:\n${input.existingFacts}\n\nNEW TURNS:\n${input.transcript}`;
  try {
    const raw = await callCheapModel(engine, SUMMARIZER_SYSTEM, user);
    if (!raw) return null;
    const jsonText = raw.replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '').trim();
    const parsed = JSON.parse(jsonText) as { summary?: unknown; facts?: unknown };
    if (typeof parsed.summary !== 'string') return null;
    return { summary: parsed.summary, factsJson: JSON.stringify(parsed.facts ?? {}) };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'memory_summarize_failed');
    return null;
  }
}

/** Smallest/cheapest chat model per provider — memory upkeep must never run
 *  on the flagship model the agent itself uses. */
async function callCheapModel(engine: EngineOverrideInput, system: string, user: string): Promise<string | null> {
  const type = engine.engineType === 'gpt4' ? 'openai' : (engine.engineType ?? 'openai');
  if (type === 'openai' || type === 'custom') {
    const base = (engine.endpoint?.replace(/\/+$/, '') || 'https://api.openai.com');
    const res = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${engine.apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 900,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`summarizer ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content ?? null;
  }
  if (type === 'claude') {
    const base = (engine.endpoint?.replace(/\/+$/, '') || 'https://api.anthropic.com');
    const res = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': engine.apiKey!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 900,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) throw new Error(`summarizer ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    return json.content?.find(c => c.type === 'text')?.text ?? null;
  }
  if (type === 'gemini') {
    const base = (engine.endpoint?.replace(/\/+$/, '') || 'https://generativelanguage.googleapis.com');
    const res = await fetch(
      `${base}/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(engine.apiKey!)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { maxOutputTokens: 900, responseMimeType: 'application/json' },
        }),
      },
    );
    if (!res.ok) throw new Error(`summarizer ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return json.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  }
  return null;
}
