/**
 * stage-events — tells a waiting browser what the agent is doing, while it
 * is still doing it.
 *
 * THE HOT-PATH RULE, same as trace/recorder.ts. Every handler here runs
 * while a customer waits, so each one builds one small object and hands it
 * to a sink. No I/O, no serialising of prompts or tool payloads, nothing
 * async. Two properties keep it off the turn's own clock:
 *
 *   awaitHandlers = false  LangChain schedules the handler on its own
 *                          background queue instead of awaiting it, so a
 *                          slow socket delays narration, never the reply.
 *   raiseError    = false  a mistake in here can never fail a turn.
 *
 * Everything this file produces is ADVISORY. A dropped event costs a
 * spinner label. That is why every failure path drops the event and
 * returns, and why the sink is allowed to refuse (see the back-pressure
 * guard in ws/gateway.ts).
 *
 * Scope note: this handler is attached to the ROOT graph invoke only.
 * LangChain propagates callbacks into child runs through async context, so
 * tools a specialist runs inside its own graph arrive here too, carrying
 * the parent's 'subagent-turn' tag — which is how they get labelled
 * without any plumbing inside runSubagentTurn.
 */
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { Serialized } from '@langchain/core/load/serializable';
import type { StageSink } from '../chat/adapters/types';

export class StageReporter extends BaseCallbackHandler {
  name = 'archon-stage-reporter';
  /** Narration must never surface as a turn failure. */
  override raiseError = false;
  /** Never awaited by the runtime — this is the latency guarantee. */
  override awaitHandlers = false;

  /** EVERY tool run in flight, reported or not. A tool reaches the runtime
   *  wrapped several layers deep — session cache, argument pre-flight,
   *  approval gate, then the tool itself — and LangChain fires a start for
   *  each layer. Only the outermost is the call the model actually made.
   *  Skipped layers are kept so their children are recognised as nested
   *  too. Mirrors trace/recorder.ts, which learned this the hard way. */
  private readonly activeToolRuns = new Set<string>();
  /** Reported runs only: run id to what we need when it ends. */
  private readonly open = new Map<string, { name: string; at: number; via?: 'specialist' }>();

  constructor(private readonly sink: StageSink) {
    super();
  }

  private send(u: Parameters<StageSink>[0]): void {
    try {
      this.sink(u);
    } catch {
      /* advisory only — a sink that throws costs a label, not a turn */
    }
  }

  override handleToolStart(
    tool: Serialized,
    _input: string,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): void {
    const nested = !!parentRunId && this.activeToolRuns.has(parentRunId);
    this.activeToolRuns.add(runId);
    if (nested) return;
    const name = runName ?? tool?.id?.[tool.id.length - 1] ?? 'tool';
    // A tool running inside a specialist's own graph inherits that graph's
    // tag, which is the only thing distinguishing it from a root-level call.
    const via = tags?.includes('subagent-turn') ? 'specialist' : undefined;
    this.open.set(runId, { name, at: Date.now(), via });
    this.send({ state: 'start', name, ...(via ? { via } : {}) });
  }

  override handleToolEnd(output: unknown, runId: string): void {
    this.activeToolRuns.delete(runId);
    const rec = this.open.get(runId);
    if (!rec) return;
    this.open.delete(runId);
    // A tool that answers with a refusal did not do the work. The reader
    // should see that at a glance rather than a tick.
    const text = typeof output === 'string' ? output : '';
    const refused = /^\s*(Error\b|REJECTED\b|PENDING_APPROVAL\b|BLOCKED\b)/.test(text);
    this.send({
      state: 'end',
      name: rec.name,
      ms: Date.now() - rec.at,
      ...(rec.via ? { via: rec.via } : {}),
      ...(refused ? { isError: true } : {}),
    });
  }

  override handleToolError(_err: Error, runId: string): void {
    this.activeToolRuns.delete(runId);
    const rec = this.open.get(runId);
    if (!rec) return;
    this.open.delete(runId);
    this.send({
      state: 'end',
      name: rec.name,
      ms: Date.now() - rec.at,
      ...(rec.via ? { via: rec.via } : {}),
      isError: true,
    });
  }

  /** Close anything still open when the turn ends, so a cancelled or
   *  crashed call does not leave the browser showing it as still running. */
  finish(): void {
    const now = Date.now();
    for (const [, rec] of this.open) {
      this.send({ state: 'end', name: rec.name, ms: now - rec.at, ...(rec.via ? { via: rec.via } : {}), isError: true });
    }
    this.open.clear();
    this.activeToolRuns.clear();
  }
}
