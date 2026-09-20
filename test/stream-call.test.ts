import { describe, it, expect, vi } from 'vitest';
import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import { callModel } from '../src/lc/stream-call';

/** A model that yields the chunks it is given, and records how it was called. */
function fakeModel(chunks: AIMessageChunk[], onInvoke?: () => AIMessage) {
  const calls = { stream: 0, invoke: 0 };
  return {
    calls,
    async stream() {
      calls.stream += 1;
      return (async function* () { for (const c of chunks) yield c; })();
    },
    async invoke() {
      calls.invoke += 1;
      return onInvoke ? onInvoke() : new AIMessage({ content: 'invoked' });
    },
  } as never;
}

const text = (t: string) => new AIMessageChunk({ content: t });
const usage = (t: string) => new AIMessageChunk({
  content: t,
  usage_metadata: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
});

describe('callModel', () => {
  it('invokes as before when nobody is listening', async () => {
    const m = fakeModel([]);
    const out = await callModel(m, []);
    expect(out.content).toBe('invoked');
    expect((m as never as { calls: { stream: number; invoke: number } }).calls).toEqual({ stream: 0, invoke: 1 });
  });

  it('returns a real AIMessage, because half the runtime tests for one', async () => {
    const out = await callModel(fakeModel([usage('a long enough reply to flush the hold window')]), [], { onDelta: () => {} });
    // AIMessageChunk is NOT an AIMessage. sumUsage and noteUsage both test
    // `instanceof AIMessage`, so a chunk here would report zero tokens for
    // a turn the provider charged for.
    expect(out).toBeInstanceOf(AIMessage);
    expect(out.usage_metadata?.input_tokens).toBe(10);
    expect(out.usage_metadata?.output_tokens).toBe(5);
  });

  it('streams text once past the hold window', async () => {
    const seen: string[] = [];
    await callModel(
      fakeModel([text('The quick brown fox jumps over'), text(' the lazy dog')]),
      [], { onDelta: t => seen.push(t) },
    );
    expect(seen.join('')).toBe('The quick brown fox jumps over the lazy dog');
  });

  it('shows a short reply that never reaches the hold window', async () => {
    const seen: string[] = [];
    await callModel(fakeModel([text('Yes.')]), [], { onDelta: t => seen.push(t) });
    expect(seen.join('')).toBe('Yes.');
  });

  it('shows nothing from a pass that turns out to be a tool call', async () => {
    const seen: string[] = [];
    const reset = vi.fn();
    const toolChunk = new AIMessageChunk({
      content: '',
      tool_call_chunks: [{ name: 'soqlQuery', args: '{"q":1}', id: 't1', index: 0, type: 'tool_call_chunk' }],
    });
    await callModel(fakeModel([toolChunk, text('some narration nobody should read')]), [], {
      onDelta: t => seen.push(t), onReset: reset,
    });
    expect(seen).toEqual([]);
    // Nothing was shown, so nothing needed retracting.
    expect(reset).not.toHaveBeenCalled();
  });

  it('retracts text when a tool call arrives after the flush', async () => {
    const seen: string[] = [];
    const reset = vi.fn();
    const toolChunk = new AIMessageChunk({
      content: '',
      tool_call_chunks: [{ name: 'soqlQuery', args: '{}', id: 't1', index: 0, type: 'tool_call_chunk' }],
    });
    await callModel(fakeModel([text('Let me look that up for you now'), toolChunk]), [], {
      onDelta: t => seen.push(t), onReset: reset,
    });
    expect(seen.join('')).toBe('Let me look that up for you now');
    expect(reset).toHaveBeenCalledOnce();
  });

  it('never shows reasoning blocks as though they were the reply', async () => {
    const seen: string[] = [];
    const mixed = new AIMessageChunk({
      content: [
        { type: 'thinking', thinking: 'the user probably means Q3 revenue' },
        { type: 'text', text: 'Revenue for Q3 was 4.2 million.' },
      ] as never,
    });
    await callModel(fakeModel([mixed]), [], { onDelta: t => seen.push(t) });
    expect(seen.join('')).toBe('Revenue for Q3 was 4.2 million.');
    expect(seen.join('')).not.toContain('probably means');
  });

  it('falls back to invoke when streaming breaks, and retracts what it showed', async () => {
    const seen: string[] = [];
    const reset = vi.fn();
    const broken = {
      async stream() {
        return (async function* () {
          yield text('Here is the first part of an answer');
          throw new Error('provider hung up');
        })();
      },
      async invoke() { return new AIMessage({ content: 'the whole answer' }); },
    } as never;
    const out = await callModel(broken, [], { onDelta: t => seen.push(t), onReset: reset });
    expect(out.content).toBe('the whole answer');
    expect(reset).toHaveBeenCalledOnce();
  });

  it('carries tool calls through to the returned message', async () => {
    const toolChunk = new AIMessageChunk({
      content: '',
      tool_call_chunks: [{ name: 'soqlQuery', args: '{"q":"SELECT Id"}', id: 't1', index: 0, type: 'tool_call_chunk' }],
    });
    const out = await callModel(fakeModel([toolChunk]), [], { onDelta: () => {} });
    // The repeat-call detector reads these, so they must survive assembly.
    expect(out.tool_calls?.[0]?.name).toBe('soqlQuery');
    expect(out.tool_calls?.[0]?.args).toEqual({ q: 'SELECT Id' });
  });
});
