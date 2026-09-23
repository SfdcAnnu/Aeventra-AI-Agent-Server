import { describe, it, expect, vi } from 'vitest';
import { callModel } from '../src/lc/stream-call';
import { AIMessage, AIMessageChunk } from '@langchain/core/messages';

/**
 * A subagent reached by HANDOFF owns the turn's reply — graph-runtime.ts
 * says so in its own header: "a subagent's reply IS the turn's reply". It
 * never streamed, so a handoff produced the worst of both: the router's
 * text streamed, stopped, and the specialist's whole answer landed at
 * once.
 *
 * A subagent reached as a CALL-MODE tool is the opposite: its reply goes
 * back to the router, which writes the real answer. Streaming that would
 * show text the router immediately replaces — the same mistake the
 * pre-tool-call buffer exists to prevent.
 *
 * So the rule is: stream whoever owns the user-facing reply. These hold
 * that callModel behaves correctly at both ends of it.
 */
const streamingModel = () => ({
  stream: async function* () {
    yield new AIMessageChunk({ content: 'Villa Project A, B and C — all available.' });
  },
  invoke: vi.fn().mockResolvedValue(new AIMessage({ content: 'Villa Project A, B and C — all available.' })),
}) as never;

describe('who streams', () => {
  it('streams when given a sink — the handoff specialist', async () => {
    const deltas: string[] = [];
    const out = await callModel(streamingModel(), [], { onDelta: d => deltas.push(d) });
    expect(deltas.join('')).toContain('Villa Project A');
    expect(out.content).toContain('Villa Project A');
  });

  it('does NOT stream without a sink — the call-mode specialist', async () => {
    const model = streamingModel() as unknown as { invoke: ReturnType<typeof vi.fn> };
    const out = await callModel(model as never, [], {});
    // No onDelta means invoke, exactly as before this change.
    expect(model.invoke).toHaveBeenCalledOnce();
    expect(out.content).toContain('Villa Project A');
  });

  it('returns the same finished message either way', async () => {
    const withSink = await callModel(streamingModel(), [], { onDelta: () => {} });
    const without = await callModel(streamingModel(), [], {});
    expect(withSink.content).toEqual(without.content);
  });
});
