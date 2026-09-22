import { describe, it, expect } from 'vitest';
import { priceFor } from '../src/architect/specialists';

/**
 * The build ceiling is stated in dollars, so a dollar has to mean the same
 * thing in every org. Cost used to come from the TIER, not the model: an
 * org on Haiku was billed at the large-tier rate and stopped at roughly a
 * quarter of the spend it had authorised, and an org on a reasoning model
 * overshot before the counter noticed. Live: a build capped at $0.95
 * stopped at $1.35.
 */
describe('priceFor', () => {
  it('prices Haiku as Haiku, not as whatever tier it was routed to', () => {
    // The live failure: a cheap model billed at $15/$75.
    expect(priceFor('claude-haiku-4-5-20251001', 'large')).toEqual({ in: 0.8, out: 4 });
  });

  it('prices Opus as Opus', () => {
    expect(priceFor('claude-opus-4-20250514', 'small')).toEqual({ in: 15, out: 75 });
  });

  it('lets a specific entry beat a family one', () => {
    // gpt-5-mini must not be priced as gpt-5.
    expect(priceFor('gpt-5-mini-2026-01-01', 'large')).toEqual({ in: 0.25, out: 2 });
    expect(priceFor('gpt-5-2026-01-01', 'large')).toEqual({ in: 1.25, out: 10 });
  });

  it('survives the version suffixes providers keep adding', () => {
    expect(priceFor('claude-sonnet-4-5-20260101', 'small')).toEqual({ in: 3, out: 15 });
    expect(priceFor('gemini-2.5-flash-preview', 'large')).toEqual({ in: 0.3, out: 2.5 });
  });

  it('ignores case, because model ids arrive in both', () => {
    expect(priceFor('GPT-4.1-MINI', 'large')).toEqual({ in: 0.4, out: 1.6 });
  });

  it('falls back to the tier for a model it does not know', () => {
    expect(priceFor('some-new-model-2027', 'small')).toEqual({ in: 0.8, out: 4 });
  });

  it('never prices an unknown model at zero, which would stop the ceiling governing', () => {
    const p = priceFor(undefined, 'large');
    expect(p.in).toBeGreaterThan(0);
    expect(p.out).toBeGreaterThan(0);
  });
});
