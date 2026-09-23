import { describe, it, expect } from 'vitest';
import { buildChatModel } from '../src/lc/models';

/**
 * A reasoning model's cap covers thinking AND the answer. The Architect's
 * specialists read a 15k-token inventory before answering; with the
 * runtime's default room for 'low' (4,000) the thinking alone used it up,
 * the answer never started, and every large-tier stage paid for an empty
 * call and a wider retry. The Architect now sets its own room.
 */
const creds = { engineType: 'openai' as const, apiKey: 'sk-test', endpoint: null, defaultModel: 'gpt-5.5', connectionId: null };
const capOf = (m: unknown) => (m as { maxTokens?: number }).maxTokens;

describe('reasoning headroom', () => {
  it('defaults by effort on a reasoning-era model', () => {
    expect(capOf(buildChatModel('gpt4', 'gpt-5.5', creds, 8_000, { reasoningEffort: 'low' }).model)).toBe(12_000);
    expect(capOf(buildChatModel('gpt4', 'gpt-5.5', creds, 8_000, { reasoningEffort: 'medium' }).model)).toBe(18_000);
  });
  it('takes the caller\'s room when given', () => {
    expect(capOf(buildChatModel('gpt4', 'gpt-5.5', creds, 4_096, { reasoningEffort: 'low', reasoningHeadroom: 12_000 }).model)).toBe(16_096);
    expect(capOf(buildChatModel('gpt4', 'gpt-5.5', creds, 8_000, { reasoningEffort: 'medium', reasoningHeadroom: 16_000 }).model)).toBe(24_000);
  });
  it('adds nothing on a model that does not reason', () => {
    expect(capOf(buildChatModel('gpt4', 'gpt-4.1', creds, 8_000, { reasoningHeadroom: 16_000 }).model)).toBe(8_000);
  });
});
