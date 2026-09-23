import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * A HARD TTL PUT THE MCP HANDSHAKE ON THE TURN'S CRITICAL PATH.
 *
 * Measured against a warm host: the same question cost 11.2s on a cache
 * miss and 3.4s on a hit. The 7.7s difference is this connect alone, on a
 * server whose plain /tools GET answers in 0.42s. With a flat 4-minute
 * expiry the slow turn landed on whoever paused to read the last answer.
 */

let connects = 0;
let connectDelayMs = 0;
const closed: string[] = [];

vi.mock('../src/chat/adapters/shared', () => ({
  ensureMcpServerAwake: vi.fn(async () => { /* awake */ }),
}));

vi.mock('@langchain/mcp-adapters', () => ({
  MultiServerMCPClient: class {
    id: string;
    constructor() { this.id = `client${++connects}`; }
    async getTools() {
      if (connectDelayMs) await new Promise(r => setTimeout(r, connectDelayMs));
      return [{ name: 'soqlQuery', description: 'd', schema: {}, invoke: async () => '' }];
    }
    async close() { closed.push(this.id); }
  },
}));

const { loadMcpTools } = await import('../src/lc/mcp-tools');

// Distinct token per test → distinct cache key, so tests don't share state.
let n = 0;
const servers = () => [{ name: 'crm', url: 'https://crm.example.com/mcp', token: `tok${n++}`, allowedTools: [] }];

// Move only the CLOCK the age check reads. Fake timers would also stop
// setTimeout, and the background refresh is a real async task -- that
// mix is what made an earlier version of this file pass while testing
// nothing: the entry never actually went stale.
let clockOffset = 0;
const realNow = Date.now;
const advance = (ms: number) => { clockOffset += ms; };

describe('MCP tool cache', () => {
  beforeEach(() => {
    connects = 0; connectDelayMs = 0; closed.length = 0; clockOffset = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
  });

  it('connects once, then serves from cache', async () => {
    const s = servers();
    await loadMcpTools(s);
    await loadMcpTools(s);
    await loadMcpTools(s);
    expect(connects).toBe(1);
  });

  it('a stale entry does NOT block the turn', async () => {
    const s = servers();
    await loadMcpTools(s);          // fresh
    advance(5 * 60 * 1000);         // past FRESH_MS, inside STALE_MS

    connectDelayMs = 3_000;          // a slow reconnect, like the real 7.7s
    const t0 = realNow();
    await loadMcpTools(s);
    const blockedFor = realNow() - t0;

    // The whole point: the turn answered without waiting for the reconnect.
    expect(blockedFor).toBeLessThan(1_000);
  });

  it('refreshes behind the turn rather than per turn', async () => {
    const s = servers();
    await loadMcpTools(s);
    advance(5 * 60 * 1000);

    // Several turns arrive while one refresh is in flight.
    connectDelayMs = 200;
    await Promise.all([loadMcpTools(s), loadMcpTools(s), loadMcpTools(s)]);
    await new Promise(r => setTimeout(r, 400));

    // One initial connect + exactly one background refresh, not three.
    expect(connects).toBe(2);
  });

  it('does not close a client a turn may still be calling', async () => {
    const s = servers();
    await loadMcpTools(s);
    advance(5 * 60 * 1000);

    await loadMcpTools(s);                       // triggers the refresh
    await new Promise(r => setTimeout(r, 200));  // refresh lands

    // Closing the replaced client immediately would break a tool call in
    // the turn that is still holding it. It closes after a grace period.
    expect(closed).toEqual([]);
  });

  it('keeps serving the cached tools when the refresh fails', async () => {
    const s = servers();
    const first = await loadMcpTools(s);
    advance(5 * 60 * 1000);

    connectDelayMs = 0;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const again = await loadMcpTools(s);
    spy.mockRestore();

    // A host that is down must not also cost us the list we already hold.
    expect(again.tools.map(t => t.name)).toEqual(first.tools.map(t => t.name));
  });
});
