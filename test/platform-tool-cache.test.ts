import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mintPlatformToken } from '../src/platform/token';

/**
 * THE PLATFORM TOKEN CHANGED EVERY TURN, SO ITS TOOLS NEVER CACHED.
 *
 * The copilot reaches the server's own tools with a JWT minted per turn.
 * The cache key used the token's tail, so every turn -- and every
 * specialist handoff inside it -- did a fresh MCP handshake to this very
 * process. Key on who the token is for, and reconnect only when the token
 * it was built with is about to expire.
 */

let connects = 0;

vi.mock('../src/chat/adapters/shared', () => ({
  ensureMcpServerAwake: vi.fn(async () => { /* awake */ }),
}));

vi.mock('@langchain/mcp-adapters', () => ({
  MultiServerMCPClient: class {
    constructor() { connects++; }
    async getTools() { return [{ name: 'home_stats', description: 'd', schema: {}, invoke: async () => '' }]; }
    async close() { /* closed */ }
  },
}));

const { loadMcpTools } = await import('../src/lc/mcp-tools');

const principal = { orgId: '00Dcache', userId: '005cache', sessionId: 'sess-cache', agentApiName: 'archon_copilot' };
const platform = (token: string) => [{ name: 'platform', url: 'http://127.0.0.1:3000/platform/mcp', token, allowedTools: [] }];

let clockOffset = 0;
const realNow = Date.now;

describe('platform tool cache', () => {
  beforeEach(() => {
    connects = 0; clockOffset = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
  });

  it('two turns with two fresh tokens for the same principal share one connection', async () => {
    await loadMcpTools(platform(mintPlatformToken(principal)));
    await new Promise(r => setTimeout(r, 1100));            // a later turn: iat differs, the token differs
    await loadMcpTools(platform(mintPlatformToken(principal)));
    expect(connects).toBe(1);
  });

  it('a different session or user is a different client', async () => {
    // The module cache lives across tests, so each line here is a principal
    // no other test has connected as.
    const p = { ...principal, sessionId: 'sess-distinct' };
    await loadMcpTools(platform(mintPlatformToken(p)));
    await loadMcpTools(platform(mintPlatformToken({ ...p, sessionId: 'sess-distinct-2' })));
    await loadMcpTools(platform(mintPlatformToken({ ...p, userId: '005other' })));
    expect(connects).toBe(3);
  });

  it('reconnects when the cached token is about to expire', async () => {
    const p = { ...principal, sessionId: 'sess-expiry' };
    await loadMcpTools(platform(mintPlatformToken(p)));
    clockOffset = 14 * 60_000 + 30_000;                     // 14m30s later: under a minute left on a 15m token
    await loadMcpTools(platform(mintPlatformToken(p)));
    expect(connects).toBe(2);
  });
});
