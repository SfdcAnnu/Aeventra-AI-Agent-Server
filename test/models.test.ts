/**
 * Which OpenAI endpoint a node's model is sent to, and with which knobs.
 * OpenAI rejects `reasoning_effort` next to function tools on
 * /v1/chat/completions for gpt-5.x, so an explicit effort has to travel
 * through /v1/responses — and there the library only knows o-series
 * names as reasoning models, so the effort goes in as a raw param.
 */
import { describe, expect, it } from 'vitest';
import { buildChatModel } from '../src/lc/models';

const engine = { engineType: 'openai', apiKey: 'k', endpoint: null, defaultModel: null, connectionId: null };
type Built = { useResponsesApi?: boolean; modelKwargs?: Record<string, unknown>; maxTokens?: number; temperature?: number };
const build = (model: string, options = {}, maxTokens = 8_000) => buildChatModel('gpt4', model, engine, maxTokens, options).model as unknown as Built;

describe('buildChatModel · OpenAI endpoint choice', () => {
  it('gpt-5.5 with an explicit effort goes through the Responses API with the effort as a raw param', () => {
    const m = build('gpt-5.5', { reasoningEffort: 'high' });
    expect(m.useResponsesApi).toBe(true);
    expect(m.modelKwargs).toEqual({ reasoning: { effort: 'high' } });
    expect(m.maxTokens).toBe(8_000 + 20_000);
  });
  it('gpt-5.5 on the default effort (Thinking: Standard) stays on chat-completions without reasoning_effort', () => {
    const m = build('gpt-5.5');
    expect(m.useResponsesApi).toBeFalsy();
    expect(m.modelKwargs).toEqual({ max_completion_tokens: 8_000 + 10_000 });
  });
  it('never sends reasoning_effort to chat-completions', () => {
    for (const effort of ['minimal', 'low', 'medium', 'high'] as const) {
      const m = build('gpt-5.5', { reasoningEffort: effort });
      expect(m.useResponsesApi).toBe(true);
      expect(m.modelKwargs).not.toHaveProperty('reasoning_effort');
      expect(m.modelKwargs).not.toHaveProperty('max_completion_tokens');
    }
  });
  it('JSON mode on the Responses path becomes text.format, not response_format', () => {
    const m = build('gpt-5.5', { reasoningEffort: 'low', jsonMode: true });
    expect(m.modelKwargs).toEqual({ reasoning: { effort: 'low' }, text: { format: { type: 'json_object' } } });
  });
  it('-pro models always take the Responses API', () => {
    const m = build('gpt-5.5-pro');
    expect(m.useResponsesApi).toBe(true);
    expect(m.modelKwargs).toEqual({});
  });
  it('gpt-4.1 keeps the plain chat-completions shape with max_tokens and temperature', () => {
    const m = build('gpt-4.1', { temperature: 0.2, jsonMode: true });
    expect(m.useResponsesApi).toBeFalsy();
    expect(m.maxTokens).toBe(8_000);
    expect(m.temperature).toBe(0.2);
    expect(m.modelKwargs).toEqual({ response_format: { type: 'json_object' } });
  });
});
