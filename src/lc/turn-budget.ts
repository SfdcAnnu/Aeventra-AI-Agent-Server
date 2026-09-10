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

export interface TurnBudget {
  deadlineAt: number;
  maxTokens: number;
  maxSteps: number;
  tokensUsed: number;
  cacheReadTokens: number;
  steps: number;
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
    cacheReadTokens: 0,
    steps: 0,
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

/** Accumulate real usage from a model response. */
export function noteUsage(b: TurnBudget, msg: AIMessage): void {
  const u = msg.usage_metadata;
  if (!u) return;
  b.tokensUsed += (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
  // Cache-hit visibility (the "highest-value alert"): OpenAI reports
  // cached prompt tokens in input_token_details.cache_read via LangChain.
  const det = (u as { input_token_details?: { cache_read?: number } }).input_token_details;
  if (det?.cache_read) b.cacheReadTokens += det.cache_read;
}

/** JSON with sorted keys so identical args always hash identically. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

/** Record one tool call; returns its repeat count (1 = first time). */
export function noteToolCall(b: TurnBudget, name: string, args: unknown): number {
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
