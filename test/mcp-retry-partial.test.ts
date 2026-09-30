import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

/**
 * Two loader behaviours from the 30 Sep 2026 run: an Event reschedule died
 * on one "read ECONNRESET" and was never retried; and a load where one
 * server was down was cached as "unavailable" for up to an hour after the
 * server came back.
 */
let connects = 0;
let failFirstInvoke = false;
let invokeCalls = 0;
let downServer = 'down';

vi.mock('../src/chat/adapters/shared', () => ({ ensureMcpServerAwake: vi.fn(async () => {}) }));
vi.mock('../src/chat/record-context', () => ({ invalidateRecordContext: vi.fn() }));
vi.mock('@langchain/mcp-adapters', () => ({
  MultiServerMCPClient: class {
    name: string;
    constructor(cfg: { mcpServers: Record<string, unknown> }) { connects++; this.name = Object.keys(cfg.mcpServers)[0]; }
    async getTools() {
      if (this.name === downServer) throw new Error('connect ECONNREFUSED');
      const { tool } = await import('@langchain/core/tools');
      return [tool(async () => {
        invokeCalls++;
        if (failFirstInvoke && invokeCalls === 1) throw new Error('request to https://sf failed, reason: read ECONNRESET');
        return '{"success":true}';
      }, { name: `updateSobjectRecord_${this.name}`, description: 'd', schema: z.object({}).passthrough() })];
    }
    async close() {}
  },
}));

const { loadMcpTools } = await import('../src/lc/mcp-tools');

let n = 0;
const srv = (name: string) => ({ name, url: `https://${name}.example.com/mcp`, token: `tok${n++}`, allowedTools: [] });

let clockOffset = 0;
const realNow = Date.now;

describe('MCP loader', () => {
  beforeEach(() => {
    connects = 0; invokeCalls = 0; failFirstInvoke = false; clockOffset = 0; downServer = 'down';
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
  });

  it('retries a dropped connection once', async () => {
    const loaded = await loadMcpTools([srv('crm')]);
    failFirstInvoke = true;
    const out = await loaded.tools[0].invoke({ id: '00U1' });
    expect(out).toBe('{"success":true}');
    expect(invokeCalls).toBe(2);
  });

  it('keeps a partial load only briefly, so a woken server is picked up', async () => {
    const servers = [srv('crm'), srv('down')];
    const first = await loadMcpTools(servers);
    expect(first.unavailable).toEqual(['down']);
    const after = connects;

    await loadMcpTools(servers);          // inside 30 s: served from cache
    expect(connects).toBe(after);

    downServer = 'nobody';                // the server wakes up
    clockOffset += 31_000;                // past the partial window
    const later = await loadMcpTools(servers);
    expect(connects).toBeGreaterThan(after);
    expect(later.unavailable).toEqual([]);
  }, 30_000);
});
