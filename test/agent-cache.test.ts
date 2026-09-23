import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * A FLAT 60s EXPIRY PUT BOTH SOQL CALLS BACK ON ALMOST EVERY REAL TURN.
 *
 * People type slower than that. Two messages a minute apart -- ordinary
 * pacing for a WhatsApp qualification -- missed the cache every time and
 * paid the agent reload BEFORE the turn clock started, which is where the
 * biggest unexplained slice of a warm turn was hiding: a turn reporting
 * 1.8s had a 3.4s wall clock, and only ~850ms of the gap was transport.
 */

let loads = 0;
let loadDelayMs = 0;
let failNext = false;

vi.mock('../src/salesforce/client', () => ({
  loadAgentDefinition: vi.fn(async (apiName: string) => {
    loads++;
    if (loadDelayMs) await new Promise(r => setTimeout(r, loadDelayMs));
    if (failNext) { failNext = false; throw new Error('salesforce slow'); }
    return { apiName, name: apiName, status: 'Active', nodes: [], loadedAt: loads };
  }),
}));
vi.mock('../src/platform/agents/registry', () => ({
  systemAgentSpec: () => undefined,   // not a platform agent: no sync path
}));

const { AgentCache } = await import('../src/chat/agent-cache');
const conn = {} as never;

// Move only the CLOCK the expiry reads; setTimeout stays real because the
// background reload is a real async task.
let clockOffset = 0;
const realNow = Date.now;
const advance = (ms: number) => { clockOffset += ms; };

let n = 0;
const agent = () => `agent_${n++}`;

describe('AgentCache', () => {
  beforeEach(() => {
    loads = 0; loadDelayMs = 0; failNext = false; clockOffset = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
  });

  it('loads once, then serves from cache', async () => {
    const a = agent();
    await AgentCache.load('org', a, conn);
    await AgentCache.load('org', a, conn);
    expect(loads).toBe(1);
  });

  it('a stale entry does NOT make the turn wait for Salesforce', async () => {
    const a = agent();
    await AgentCache.load('org', a, conn);
    advance(2 * 60_000);            // past FRESH_MS, inside STALE_MS

    loadDelayMs = 2_000;             // a slow reload, like a real SOQL pair
    const t0 = realNow();
    const got = await AgentCache.load('org', a, conn);
    const waited = realNow() - t0;

    expect(got?.apiName).toBe(a);
    expect(waited).toBeLessThan(500);
  });

  it('runs ONE reload for however many turns arrive while it is stale', async () => {
    const a = agent();
    await AgentCache.load('org', a, conn);
    advance(2 * 60_000);
    loadDelayMs = 150;
    await Promise.all([
      AgentCache.load('org', a, conn),
      AgentCache.load('org', a, conn),
      AgentCache.load('org', a, conn),
    ]);
    await new Promise(r => setTimeout(r, 300));
    expect(loads).toBe(2);           // initial + exactly one background reload
  });

  it('keeps serving the definition it holds when the reload fails', async () => {
    const a = agent();
    const first = await AgentCache.load('org', a, conn);
    advance(2 * 60_000);
    failNext = true;
    const again = await AgentCache.load('org', a, conn);
    await new Promise(r => setTimeout(r, 50));
    expect(again).toEqual(first);
  });

  it('invalidate() still makes the next turn block for a fresh copy', async () => {
    // The Save flow's promise -- an edit shows on the very next turn --
    // must survive the stale window.
    const a = agent();
    await AgentCache.load('org', a, conn);
    AgentCache.invalidate('org', a);
    loadDelayMs = 100;
    const t0 = realNow();
    await AgentCache.load('org', a, conn);
    expect(realNow() - t0).toBeGreaterThanOrEqual(90);
    expect(loads).toBe(2);
  });

  it('blocks again once the entry is older than the stale window', async () => {
    const a = agent();
    await AgentCache.load('org', a, conn);
    advance(31 * 60_000);            // past STALE_MS
    loadDelayMs = 100;
    const t0 = realNow();
    await AgentCache.load('org', a, conn);
    expect(realNow() - t0).toBeGreaterThanOrEqual(90);
  });
});
