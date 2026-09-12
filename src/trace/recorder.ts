/**
 * recorder — collects what happened during a turn, and costs the turn
 * nothing to do it.
 *
 * THE HOT-PATH RULE. Every handler here runs while a customer is waiting,
 * so each one does the least possible work: record a timestamp, keep a
 * REFERENCE to objects that already exist, push to an array. No I/O, no
 * serialising, no redaction, nothing async — LangChain awaits callbacks,
 * so anything slow here is latency the customer pays. A 15,000-token
 * prompt costs the same to record as a one-line one, because nothing is
 * copied.
 *
 * Everything expensive — redaction, JSON, the database — happens in
 * writer.ts AFTER the reply has gone out.
 */
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { Serialized } from '@langchain/core/load/serializable';
import type { BaseMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';

export interface RecordedStep {
  seq: number;
  kind: 'model_call' | 'tool_call';
  stage: string;
  name: string;
  model?: string;
  /** References, not copies — serialised later, off the hot path. */
  request?: unknown;
  response?: unknown;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  latencyMs: number;
  isError: boolean;
  error?: string;
  startedAt: Date;
  finishedAt?: Date;
}

/** Cheap guard so a pathological turn cannot grow memory without bound. */
const MAX_STEPS = Number(process.env.TRACE_MAX_STEPS) || 120;

export class TurnRecorder extends BaseCallbackHandler {
  name = 'archon-turn-recorder';
  /** Never let a recording mistake surface as a turn failure. */
  override raiseError = false;
  override awaitHandlers = false;

  readonly steps: RecordedStep[] = [];
  private readonly open = new Map<string, RecordedStep>();
  private seq = 0;

  private begin(step: Omit<RecordedStep, 'seq' | 'startedAt' | 'tokensIn' | 'tokensOut' | 'cacheRead' | 'latencyMs' | 'isError'>, runId: string): void {
    if (this.steps.length >= MAX_STEPS) return;
    const rec: RecordedStep = {
      ...step, seq: this.seq++, startedAt: new Date(),
      tokensIn: 0, tokensOut: 0, cacheRead: 0, latencyMs: 0, isError: false,
    };
    this.steps.push(rec);
    this.open.set(runId, rec);
  }

  private close(runId: string, apply: (r: RecordedStep) => void): void {
    const rec = this.open.get(runId);
    if (!rec) return;
    this.open.delete(runId);
    rec.finishedAt = new Date();
    rec.latencyMs = rec.finishedAt.getTime() - rec.startedAt.getTime();
    apply(rec);
  }

  /** Which half of the graph this call belongs to. Derived from the tags
   *  the invoke config already sets — no new plumbing. */
  private static stageFrom(tags?: string[]): string {
    if (!tags) return 'router';
    if (tags.includes('subagent-turn')) return 'subagent';
    if (tags.includes('claim-guard')) return 'guardrail_regen';
    return 'router';
  }

  override handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
    _parentRunId?: string,
    extraParams?: Record<string, unknown>,
    tags?: string[],
  ): void {
    const params = (extraParams?.invocation_params ?? {}) as Record<string, unknown>;
    const model = typeof params.model === 'string' ? params.model
      : (llm?.id?.[llm.id.length - 1] ?? 'model');
    this.begin({
      kind: 'model_call',
      stage: TurnRecorder.stageFrom(tags),
      name: String(model),
      model: String(model),
      // Held by reference. These arrays are not mutated after the call.
      request: { messages: messages[0] ?? [], params },
    }, runId);
  }

  override handleLLMEnd(output: LLMResult, runId: string): void {
    this.close(runId, rec => {
      rec.response = output;
      // LangChain normalises usage onto the generation message; the raw
      // llmOutput shape differs per provider, so read both.
      const gen = output.generations?.[0]?.[0] as { message?: { usage_metadata?: Record<string, unknown> } } | undefined;
      const usage = (gen?.message?.usage_metadata ?? output.llmOutput?.tokenUsage ?? {}) as Record<string, unknown>;
      const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      rec.tokensIn = n(usage.input_tokens) || n(usage.promptTokens);
      rec.tokensOut = n(usage.output_tokens) || n(usage.completionTokens);
      const det = usage.input_token_details as { cache_read?: unknown } | undefined;
      rec.cacheRead = n(det?.cache_read);
    });
  }

  override handleLLMError(err: Error, runId: string): void {
    this.close(runId, rec => {
      rec.isError = true;
      rec.error = err?.message ?? String(err);
      rec.response = err;
    });
  }

  override handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    _parentRunId?: string,
    tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): void {
    this.begin({
      kind: 'tool_call',
      stage: 'tools',
      name: runName ?? tool?.id?.[tool.id.length - 1] ?? 'tool',
      request: input,
    }, runId);
    void tags;
  }

  override handleToolEnd(output: unknown, runId: string): void {
    this.close(runId, rec => {
      rec.response = output;
      // A tool that answers with a refusal or an error string did not do
      // the work, and the console should show that at a glance.
      const text = typeof output === 'string' ? output : '';
      if (/^\s*(Error\b|REJECTED\b|PENDING_APPROVAL\b|BLOCKED\b)/.test(text)) {
        rec.isError = true;
        rec.error = text.slice(0, 300);
      }
    });
  }

  override handleToolError(err: Error, runId: string): void {
    this.close(runId, rec => {
      rec.isError = true;
      rec.error = err?.message ?? String(err);
      rec.response = err;
    });
  }

  /** Anything still open when the turn ends (a cancelled or crashed call)
   *  is closed so the console shows it rather than silently dropping it. */
  finish(): RecordedStep[] {
    const now = new Date();
    for (const [, rec] of this.open) {
      rec.finishedAt = now;
      rec.latencyMs = now.getTime() - rec.startedAt.getTime();
      if (!rec.isError) { rec.isError = true; rec.error = 'never completed'; }
    }
    this.open.clear();
    return this.steps;
  }
}

/** Tracing is off unless explicitly switched on. Read per call so an env
 *  change takes effect on the next restart without a code path to flip. */
export function traceCaptureEnabled(): boolean {
  return (process.env.TRACE_CAPTURE ?? '').toLowerCase() === 'full';
}
