import { describe, it, expect } from 'vitest';
import { StageReporter } from '../src/lc/stage-events';
import type { StageUpdate } from '../src/chat/adapters/types';

/** The runtime wraps one model tool in several layers — session cache,
 *  argument pre-flight, approval gate, then the tool. LangChain fires a
 *  start for each, and each one's parent is the layer above it. */
const serialized = (id: string) => ({ lc: 1, type: 'not_implemented' as const, id: ['tools', id] });

function collect() {
  const seen: StageUpdate[] = [];
  return { seen, sink: (u: StageUpdate) => { seen.push(u); } };
}

describe('StageReporter', () => {
  it('reports the call the model made, not the wrappers around it', () => {
    const { seen, sink } = collect();
    const r = new StageReporter(sink);

    // outermost wrapper, then two layers beneath it, then the end
    r.handleToolStart(serialized('cache'), '{}', 'run-1', undefined, [], undefined, 'soqlQuery');
    r.handleToolStart(serialized('gate'), '{}', 'run-2', 'run-1', [], undefined, 'soqlQuery');
    r.handleToolStart(serialized('mcp'), '{}', 'run-3', 'run-2', [], undefined, 'soqlQuery');
    r.handleToolEnd('rows', 'run-3');
    r.handleToolEnd('rows', 'run-2');
    r.handleToolEnd('rows', 'run-1');

    expect(seen.map(u => u.state)).toEqual(['start', 'end']);
    expect(seen[0].name).toBe('soqlQuery');
    expect(seen[1].ms).toBeTypeOf('number');
  });

  it('labels a call that ran inside a specialist', () => {
    const { seen, sink } = collect();
    const r = new StageReporter(sink);
    r.handleToolStart(serialized('t'), '{}', 'a', undefined, ['subagent-turn', 'agent'], undefined, 'describeObject');
    expect(seen[0].via).toBe('specialist');

    const root = collect();
    const r2 = new StageReporter(root.sink);
    r2.handleToolStart(serialized('t'), '{}', 'b', undefined, ['chat-turn'], undefined, 'describeObject');
    expect(root.seen[0].via).toBeUndefined();
  });

  it('marks a refused or parked call as an error', () => {
    const { seen, sink } = collect();
    const r = new StageReporter(sink);
    r.handleToolStart(serialized('t'), '{}', 'a', undefined, [], undefined, 'deployMetadata');
    r.handleToolEnd('PENDING_APPROVAL: waiting on a human', 'a');
    expect(seen[1].isError).toBe(true);
  });

  it('closes anything still open when the turn ends', () => {
    const { seen, sink } = collect();
    const r = new StageReporter(sink);
    r.handleToolStart(serialized('t'), '{}', 'a', undefined, [], undefined, 'slowTool');
    r.finish();
    expect(seen.map(u => u.state)).toEqual(['start', 'end']);
    expect(seen[1].isError).toBe(true);
    // finish is idempotent — a second call reports nothing further
    r.finish();
    expect(seen).toHaveLength(2);
  });

  it('never lets a failing sink reach the turn', () => {
    const r = new StageReporter(() => { throw new Error('socket gone'); });
    expect(() => {
      r.handleToolStart(serialized('t'), '{}', 'a', undefined, [], undefined, 'anyTool');
      r.handleToolEnd('ok', 'a');
      r.handleToolError(new Error('boom'), 'b');
      r.finish();
    }).not.toThrow();
  });

  it('stays off the turn clock and never fails it', () => {
    const r = new StageReporter(() => {});
    // These two flags ARE the latency guarantee: LangChain schedules the
    // handler on its background queue instead of awaiting it, and a throw
    // in here is swallowed rather than failing the run.
    expect(r.awaitHandlers).toBe(false);
    expect(r.raiseError).toBe(false);
  });
});
