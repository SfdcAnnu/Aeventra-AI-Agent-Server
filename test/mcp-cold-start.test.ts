import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * THE FIRST TURN AFTER IDLE USED TO HAVE NO TOOLS AT ALL.
 *
 * ensureMcpServerAwake was written for the provider-hosted adapter path
 * and never wired into the graph runtime that replaced it. The runtime's
 * own absorption was LIST_RETRY_WAITS_MS = [1_500, 4_000] — 5.5s of
 * patience against a Render free-tier host that takes ~30s to wake. So
 * every first turn after an idle period put the server in `unavailable`,
 * the model read the connector notice out loud ("I can't reach that right
 * now, try again shortly"), and the person got a deflection instead of an
 * answer. Live-confirmed: the CRM MCP server woke in 31.6s while the turn
 * gave up at 9.5s having called nothing.
 */

const awoken: string[] = [];
let connectOrder: string[] = [];

vi.mock('../src/chat/adapters/shared', () => ({
  ensureMcpServerAwake: vi.fn(async (base: string) => {
    awoken.push(base);
    await new Promise(r => setTimeout(r, 10));
  }),
}));

vi.mock('@langchain/mcp-adapters', () => ({
  MultiServerMCPClient: class {
    constructor(cfg: any) { connectOrder.push('connect:' + Object.keys(cfg.mcpServers)[0]); }
    async getTools() { return [{ name: 'soqlQuery', description: 'd', schema: {}, invoke: async () => '' }]; }
    async close() { /* no-op */ }
  },
}));

const { loadMcpTools } = await import('../src/lc/mcp-tools');

const server = (name: string, url: string) => ({ name, url, token: 't', allowedTools: [] });

describe('MCP cold start', () => {
  beforeEach(() => { awoken.length = 0; connectOrder = []; });

  it('wakes the host BEFORE connecting, not after failing', async () => {
    await loadMcpTools([server('crm', 'https://crm.example.com/mcp')]);
    expect(awoken).toEqual(['https://crm.example.com']);
    // Ordering is the whole point: a wake after the connect attempt is
    // exactly the bug — the turn has already lost its tools by then.
    expect(awoken.length).toBe(1);
    expect(connectOrder).toEqual(['connect:crm']);
  });

  it('wakes by ORIGIN, so the ?custom= query string still hits the memo', async () => {
    await loadMcpTools([server('crm', 'https://crm.example.com/mcp?custom=apex:Foo')]);
    expect(awoken).toEqual(['https://crm.example.com']);
  });

  it('wakes each host once, not once per server entry', async () => {
    await loadMcpTools([
      server('crm', 'https://same.example.com/mcp'),
      server('crm2', 'https://same.example.com/mcp?custom=flow:Bar'),
    ]);
    expect(awoken).toEqual(['https://same.example.com']);
  });

  it('skips the wake when the turn has no time to spare', async () => {
    // A deadline inside MODEL_FLOOR_MS: spending the remaining clock on a
    // wake would hand the person the budget brake ("our team will follow
    // up") instead of the honest "try again shortly" — strictly worse.
    await loadMcpTools([server('crm', 'https://tight.example.com/mcp')], {
      deadlineAt: Date.now() + 5_000,
    });
    expect(awoken).toEqual([]);
    // It still tries to connect — a warm host answers fine.
    expect(connectOrder).toEqual(['connect:crm']);
  });

  it('wakes when the deadline leaves room', async () => {
    await loadMcpTools([server('crm', 'https://roomy.example.com/mcp')], {
      deadlineAt: Date.now() + 90_000,
    });
    expect(awoken).toEqual(['https://roomy.example.com']);
  });

  it('does not throw on a malformed url', async () => {
    await expect(loadMcpTools([server('bad', 'not-a-url')])).resolves.toBeTruthy();
    expect(awoken).toEqual([]);
  });
});
