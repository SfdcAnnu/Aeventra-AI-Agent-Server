import { describe, it, expect } from 'vitest';
import { spillIfLarge, ARTIFACT_THRESHOLD } from '../src/lc/artifact-store';

/**
 * A week of home_stats is ~2,160 characters, just over the 2,000-character
 * spill: the copilot paid a read_artifact round trip -- one more model
 * call -- on every stats question. The platform's own tools return bounded
 * JSON the model needs whole, so they spill at 12,000 instead.
 */
// 31 days: the same shape as a month of home_stats, over the default threshold, under the platform's.
const stats = JSON.stringify({ days: 31, byDay: Array.from({ length: 31 }, (_, i) => ({ day: `2026-09-${String(1 + i).padStart(2, '0')}`, runsOk: 0, runsFailed: 0, runsOther: 0, turnsOk: 10 + i, turnsFailed: 0 })), byAgent: [{ apiName: 'whatsapp_lead_intake_qualifier', name: 'WhatsApp Lead Intake Qualifier', turns: 114, tokensIn: 500000, tokensOut: 7000 }] }, null, 2);

describe('spill threshold per server', () => {
  it('a month of stats is over the default threshold and would spill', () => {
    expect(stats.length).toBeGreaterThan(ARTIFACT_THRESHOLD);
    expect(spillIfLarge('home_stats', stats)).toContain('"artifact":"art_');
  });
  it('the platform threshold keeps it whole', () => {
    expect(spillIfLarge('home_stats', stats, 12_000)).toBe(stats);
  });
  it('a genuinely large result still spills under the platform threshold', () => {
    const huge = JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => ({ id: `001${i}`, name: `Account ${i}`, notes: 'x'.repeat(40) })) });
    expect(huge.length).toBeGreaterThan(12_000);
    expect(spillIfLarge('soqlQuery', huge, 12_000)).toContain('"artifact":"art_');
  });
});
