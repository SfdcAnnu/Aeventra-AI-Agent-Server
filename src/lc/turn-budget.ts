/**
 * turn-budget — Phase 1 runtime safety rails. Four brakes, checked BEFORE
 * every model invoke (never after the money is spent):
 *
 *   token budget   — one turn may spend at most N tokens (runaway-bill stop)
 *   time budget    — past the deadline, stop working and answer NOW
 *                    (frozen-customer stop; must stay under the Apex
 *                    callout timeout so the bridge never gives up first)
 *   step budget    — model-invoke count per turn (formalizes the old
 *                    recursion cap as a first-class control)
 *   loop detector  — the same tool called with byte-identical arguments is
 *                    blocked with a corrective tool result; persistent
 *                    repetition trips the turn
 *
 * On a trip the customer gets a graceful reply and the log records exactly
 * which brake fired — never a hang, never a silent overrun. On normal
 * turns none of this does anything.
 *
 * Per-agent overrides come from the root AI node's ConfigJson
 * (`budgets: { maxTokens, maxMs, maxSteps }`), clamped to platform
 * ceilings from env. Generic — no agent-specific values live here.
 */
import type { AIMessage } from '@langchain/core/messages';
import type { ModelUsage } from '../chat/adapters/types';

/** Phase 7 — one billable transition. Model calls carry tokens; tool
 *  calls carry the name. Emitted at turn end as the `lc_billing` event —
 *  the per-tenant metering feed (log-based today, durable sink later). */
export interface BillingEvent {
  kind: 'model_call' | 'tool_call';
  stage: string;
  name?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheRead?: number;
}

const MAX_EVENTS = 300;

export interface TurnBudget {
  deadlineAt: number;
  maxTokens: number;
  maxSteps: number;
  tokensUsed: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  modelCalls: number;
  steps: number;
  events: BillingEvent[];
  callCounts: Map<string, number>;
  /** Set when a brake fires — later passes (corrections, regens) skip. */
  tripped: string | null;
}

const envInt = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

// Platform ceilings (env-overridable). Defaults sized for a chat turn:
// the time ceiling stays under Apex's 120s callout timeout.
const CEIL_TOKENS = envInt('TURN_MAX_TOKENS_CEILING', 200_000);
const CEIL_MS = envInt('TURN_MAX_MS_CEILING', 110_000);
const CEIL_STEPS = envInt('TURN_MAX_STEPS_CEILING', 40);

const DEFAULT_TOKENS = envInt('TURN_MAX_TOKENS', 80_000);
const DEFAULT_MS = envInt('TURN_MAX_MS', 90_000);
const DEFAULT_STEPS = envInt('TURN_MAX_STEPS', 24);

/** Identical-call block threshold and the hard trip threshold above it. */
export const REPEAT_BLOCK_AT = 2;   // 3rd identical call is blocked
const REPEAT_TRIP_AT = 5;           // persistent repetition ends the turn

export function createTurnBudget(rootNodeConfig: unknown): TurnBudget {
  const cfg = ((rootNodeConfig ?? {}) as { budgets?: { maxTokens?: unknown; maxMs?: unknown; maxSteps?: unknown } }).budgets ?? {};
  const pick = (v: unknown, fallback: number, ceiling: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.min(n, ceiling) : Math.min(fallback, ceiling);
  };
  return {
    deadlineAt: Date.now() + pick(cfg.maxMs, DEFAULT_MS, CEIL_MS),
    maxTokens: pick(cfg.maxTokens, DEFAULT_TOKENS, CEIL_TOKENS),
    maxSteps: pick(cfg.maxSteps, DEFAULT_STEPS, CEIL_STEPS),
    tokensUsed: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    modelCalls: 0,
    steps: 0,
    events: [],
    callCounts: new Map(),
    tripped: null,
  };
}

/** Returns the violated brake, or null. Called BEFORE each model invoke. */
export function checkBudget(b: TurnBudget): string | null {
  if (b.tripped) return b.tripped;
  if (Date.now() >= b.deadlineAt) return 'deadline';
  if (b.tokensUsed >= b.maxTokens) return 'token_budget';
  if (b.steps >= b.maxSteps) return 'step_budget';
  return null;
}

/** Accumulate real usage from a model response; each call is also one
 *  billable transition (Phase 7). */
/**
 * How many input tokens were served from the prompt cache.
 *
 * Worth reading from several shapes, because the providers do not agree
 * and the library only normalises one of them:
 *
 *  - Chat Completions reports `prompt_tokens_details.cached_tokens`, which
 *    LangChain maps to usage_metadata.input_token_details.cache_read.
 *  - The RESPONSES API reports `input_tokens_details.cached_tokens` — a
 *    different key that the installed @langchain/openai does not map at
 *    all, so cache_read reads 0 there no matter how well the cache is
 *    working. Every `-pro` model runs on that path, so without this the
 *    cached share of our biggest, most expensive prompts is invisible.
 *  - Anthropic reports cache reads separately again.
 *
 * Falls back through the raw response metadata rather than trusting one
 * normalised field. Returns 0 when nothing reports a hit.
 */
function readCacheHits(msg: AIMessage): number {
  const asNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

  const normalised = (msg.usage_metadata as
    | { input_token_details?: { cache_read?: unknown } }
    | undefined)?.input_token_details?.cache_read;
  if (asNum(normalised)) return asNum(normalised);

  const meta = msg.response_metadata as Record<string, unknown> | undefined;
  const usage = (meta?.usage ?? meta?.tokenUsage ?? meta?.estimatedTokenUsage) as
    | Record<string, unknown>
    | undefined;
  if (!usage) return 0;

  const candidates: unknown[] = [
    // Responses API
    (usage.input_tokens_details as { cached_tokens?: unknown } | undefined)?.cached_tokens,
    // Chat Completions, straight from the raw payload
    (usage.prompt_tokens_details as { cached_tokens?: unknown } | undefined)?.cached_tokens,
    // Anthropic
    usage.cache_read_input_tokens,
  ];
  for (const c of candidates) {
    const n = asNum(c);
    if (n) return n;
  }
  return 0;
}

export function noteUsage(b: TurnBudget, msg: AIMessage, stage = 'model', model?: string): void {
  b.modelCalls += 1;
  const u = msg.usage_metadata;
  if (!u) return;
  const tokensIn = u.input_tokens ?? 0;
  const tokensOut = u.output_tokens ?? 0;
  b.tokensUsed += tokensIn + tokensOut;
  b.tokensIn += tokensIn;
  b.tokensOut += tokensOut;
  const cacheRead = readCacheHits(msg);
  if (cacheRead) b.cacheReadTokens += cacheRead;
  if (b.events.length < MAX_EVENTS) {
    b.events.push({ kind: 'model_call', stage, model, tokensIn, tokensOut, ...(cacheRead ? { cacheRead } : {}) });
  }
}

/** JSON with sorted keys so identical args always hash identically. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

/** Record one tool call; returns its repeat count (1 = first time). */
/** Collapse the turn's model_call events into one row per model.
 *
 *  This is what makes "tokens by model" truthful: a turn that routes on
 *  gpt-5.5 and hands off to a haiku specialist reports both, with their own
 *  token counts, instead of charging the whole turn to whichever model
 *  happened to speak last. Sums back exactly to b.tokensIn / b.tokensOut. */
export function usageByModel(b: TurnBudget): ModelUsage[] {
  const byModel = new Map<string, ModelUsage>();
  for (const e of b.events) {
    if (e.kind !== 'model_call') continue;
    // A provider that reported no model name still consumed tokens —
    // bucket it honestly rather than dropping it from the totals.
    const key = e.model || 'unknown';
    let row = byModel.get(key);
    if (!row) {
      row = { model: key, stages: [], calls: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0 };
      byModel.set(key, row);
    }
    row.calls += 1;
    row.tokensIn += e.tokensIn ?? 0;
    row.tokensOut += e.tokensOut ?? 0;
    row.cacheRead += e.cacheRead ?? 0;
    if (e.stage && !row.stages.includes(e.stage)) row.stages.push(e.stage);
  }
  return [...byModel.values()].sort((a, b2) => (b2.tokensIn + b2.tokensOut) - (a.tokensIn + a.tokensOut));
}

export function noteToolCall(b: TurnBudget, name: string, args: unknown, stage = 'tools'): number {
  if (b.events.length < MAX_EVENTS) b.events.push({ kind: 'tool_call', stage, name });
  const sig = `${name}|${stableStringify(args ?? {})}`;
  const count = (b.callCounts.get(sig) ?? 0) + 1;
  b.callCounts.set(sig, count);
  if (count >= REPEAT_TRIP_AT) b.tripped = 'tool_loop';
  return count;
}

/** Customer-safe reply when a brake ends the turn — generic, no internals. */
export const BUDGET_TRIPPED_REPLY =
  'I want to make sure you get an accurate answer on this, so our team will follow up with you shortly.';

export const REPEATED_CALL_RESULT =
  'BLOCKED — you already called this tool with these exact arguments in this turn. Use the earlier result from ' +
  'the conversation, take a different action, or give your final answer now.';
