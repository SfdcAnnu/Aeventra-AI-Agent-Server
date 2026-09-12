/**
 * writer — persists a recorded turn, entirely off the hot path.
 *
 * Called as `void persistTrace(...)` AFTER the reply is on the wire, so
 * none of the work below is time a customer waits: redaction, JSON
 * serialising, splitting the prompt into parts, and the database write all
 * happen here.
 *
 * Two rules this file exists to enforce:
 *
 *   TRACING NEVER BREAKS A TURN. Every path is wrapped; a failure is
 *   logged and swallowed. The reply has already been delivered — there is
 *   nothing left to fail.
 *
 *   TRACING YIELDS UNDER LOAD. Writes go through a bounded queue. When it
 *   fills, payloads are dropped before the metrics row is, and the whole
 *   job is dropped before the runtime is ever made to wait. A tracer that
 *   causes back-pressure is worse than no tracer.
 */
import { prisma } from '../db/client';
import { logger } from '../logger';
import { redactForStorage } from './redact';
import { describeRequest, toWireMessages, toWireResponse } from './prompt-parts';
import type { RecordedStep } from './recorder';
import type { BaseMessage } from '@langchain/core/messages';

const envInt = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** Jobs waiting to be written. Past this, new jobs are dropped rather
 *  than queued — memory is not the place to absorb a database outage. */
const MAX_QUEUE = envInt('TRACE_QUEUE_MAX', 200);
/** Beyond this many queued, keep the metrics row but discard the bodies:
 *  degrade the detail, not the visibility. */
const SHED_PAYLOADS_AT = envInt('TRACE_SHED_PAYLOADS_AT', 80);
/** Cap per step body. */
const MAX_BODY_CHARS = envInt('TRACE_MAX_BODY_CHARS', 200_000);

export interface TraceContext {
  orgId: string;
  userId?: string | null;
  agentApiName: string;
  agentId?: string | null;
  agentName?: string | null;
  sessionId?: string | null;
  correlationId?: string | null;
  recordId?: string | null;
  channel?: string | null;
}

export interface TraceTotals {
  status: 'complete' | 'error';
  errorCode?: string | null;
  errorMessage?: string | null;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  latencyMs: number;
  usageByModel?: unknown;
}

interface Job { ctx: TraceContext; totals: TraceTotals; steps: RecordedStep[] }

const queue: Job[] = [];
let draining = false;

/** Queue a finished turn. Returns immediately; never throws. */
export function persistTrace(ctx: TraceContext, totals: TraceTotals, steps: RecordedStep[]): void {
  try {
    if (queue.length >= MAX_QUEUE) {
      logger.warn({ orgId: ctx.orgId, queued: queue.length }, 'trace_dropped_queue_full');
      return;
    }
    queue.push({ ctx, totals, steps });
    if (!draining) void drain();
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'trace_enqueue_failed');
  }
}

async function drain(): Promise<void> {
  draining = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift()!;
      // Under pressure the bodies go first — a row saying WHICH turn was
      // slow is far more useful than nothing at all.
      const keepPayloads = queue.length < SHED_PAYLOADS_AT;
      try {
        await writeOne(job, keepPayloads);
      } catch (err) {
        logger.warn(
          { orgId: job.ctx.orgId, err: err instanceof Error ? err.message : err },
          'trace_write_failed',
        );
      }
    }
  } finally {
    draining = false;
  }
}

async function writeOne(job: Job, keepPayloads: boolean): Promise<void> {
  const { ctx, totals, steps } = job;
  const modelCalls = steps.filter(s => s.kind === 'model_call').length;
  const toolCalls = steps.filter(s => s.kind === 'tool_call').length;

  await prisma.agentTrace.create({
    data: {
      orgId: ctx.orgId,
      userId: ctx.userId ?? null,
      agentApiName: ctx.agentApiName,
      agentId: ctx.agentId ?? null,
      agentName: ctx.agentName ?? null,
      sessionId: ctx.sessionId ?? null,
      correlationId: ctx.correlationId ?? null,
      recordId: ctx.recordId ?? null,
      channel: ctx.channel ?? 'chat',
      status: totals.status,
      errorCode: totals.errorCode ?? null,
      errorMessage: totals.errorMessage ? String(totals.errorMessage).slice(0, 2_000) : null,
      modelCalls,
      toolCalls,
      tokensIn: totals.tokensIn,
      tokensOut: totals.tokensOut,
      cachedTokens: totals.cachedTokens,
      latencyMs: totals.latencyMs,
      usageByModel: (redactForStorage(totals.usageByModel) ?? undefined) as never,
      steps: {
        create: steps.map(s => ({
          seq: s.seq,
          kind: s.kind,
          stage: s.stage,
          name: s.name.slice(0, 200),
          model: s.model ?? null,
          requestJson: keepPayloads ? (redactForStorage(wireRequest(s), MAX_BODY_CHARS) as never) : undefined,
          requestParts: keepPayloads ? (partsFor(s) as never) : undefined,
          responseJson: keepPayloads ? (redactForStorage(wireResponse(s), MAX_BODY_CHARS) as never) : undefined,
          tokensIn: s.tokensIn,
          tokensOut: s.tokensOut,
          cacheRead: s.cacheRead,
          latencyMs: s.latencyMs,
          isError: s.isError,
          error: s.error ? s.error.slice(0, 2_000) : null,
          startedAt: s.startedAt,
          finishedAt: s.finishedAt ?? null,
        })),
      },
    },
  });
}

/** A model call's request as the provider receives it — LangChain's
 *  Serializable internals (lc_kwargs, lc_namespace, circular
 *  additional_kwargs) stripped, so the stored body is the real one and not
 *  a doubled copy of it. Tool calls pass through unchanged; their input is
 *  already a plain value. */
function wireRequest(step: RecordedStep): unknown {
  if (step.kind !== 'model_call') return step.request;
  try {
    const req = step.request as { messages?: BaseMessage[]; params?: Record<string, unknown> } | undefined;
    if (!req?.messages) return step.request;
    return { ...(req.params ?? {}), messages: toWireMessages(req.messages) };
  } catch {
    return step.request;
  }
}

/** A model response stripped to what is worth reading. Tool results and
 *  errors pass through — they are already plain values. */
function wireResponse(step: RecordedStep): unknown {
  if (step.kind !== 'model_call' || !step.response) return step.response;
  try {
    return toWireResponse(step.response);
  } catch {
    return step.response;
  }
}

/** The composed view — only meaningful for a model call, and never worth
 *  failing a write over. */
function partsFor(step: RecordedStep): unknown {
  if (step.kind !== 'model_call') return undefined;
  try {
    const req = step.request as { messages?: BaseMessage[]; params?: Record<string, unknown> } | undefined;
    if (!req?.messages) return undefined;
    return redactForStorage(describeRequest(req.messages, req.params ?? {}), MAX_BODY_CHARS);
  } catch {
    return undefined;
  }
}
