import { afterEach, describe, expect, it, vi } from 'vitest';
import { mcpListTools } from '../src/mcp/clients/streamable-http-client';

/**
 * The Org Surveyor's own MCP client must accept every shape a compliant
 * server can answer with. The gap that bit us: a STATELESS server (SDK v2,
 * the 2026-07-28 shape) never issues an mcp-session-id — a valid
 * initialize was thrown away as "initialize failed (200)" and the
 * Architect refused to design because the connector "could not be read".
 */

const TOOLS = [{ name: 'describe_object', description: 'trimmed describe', inputSchema: { type: 'object' } }];

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
}
function sseResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...headers },
  });
}

/** A fake server: records every request, answers by JSON-RPC method. */
function fakeServer(opts: { sessionId?: string; sse?: boolean }) {
  const calls: Array<{ method: string; headers: Record<string, string>; rpc: string | null }> = [];
  const reply = opts.sse ? sseResponse : jsonResponse;
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init?.body ? (JSON.parse(String(init.body)) as { method?: string }) : null;
    calls.push({ method: init?.method ?? 'GET', headers, rpc: body?.method ?? null });
    if (body?.method === 'initialize') {
      return reply(
        { jsonrpc: '2.0', id: 'init', result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } },
        opts.sessionId ? { 'mcp-session-id': opts.sessionId } : {},
      );
    }
    if (body?.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body?.method === 'tools/list') return reply({ jsonrpc: '2.0', id: 'list', result: { tools: TOOLS } });
    if (init?.method === 'DELETE') return new Response(null, { status: 200 });
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('surveyor MCP client', () => {
  it('lists tools from a stateless server that issues no session id (JSON replies)', async () => {
    const server = fakeServer({});
    const tools = await mcpListTools({ remoteUrl: 'https://mcp.example.test', accessToken: 'tok' });
    expect(tools.map(t => t.name)).toEqual(['describe_object']);
    // no phantom session: the header is never sent empty, and nothing is closed
    expect(server.calls.every(c => !('mcp-session-id' in c.headers))).toBe(true);
    expect(server.calls.some(c => c.method === 'DELETE')).toBe(false);
  });

  it('lists tools from a stateless server that answers with SSE frames', async () => {
    fakeServer({ sse: true });
    const tools = await mcpListTools({ remoteUrl: 'https://mcp.example.test/', accessToken: 'tok' });
    expect(tools.map(t => t.name)).toEqual(['describe_object']);
  });

  it('still drives a session-issuing server through its session and closes it', async () => {
    const server = fakeServer({ sessionId: 'sess-42' });
    const tools = await mcpListTools({ remoteUrl: 'https://mcp.example.test', accessToken: 'tok' });
    expect(tools).toHaveLength(1);
    const afterInit = server.calls.filter(c => c.rpc !== 'initialize');
    expect(afterInit.every(c => c.headers['mcp-session-id'] === 'sess-42')).toBe(true);
    expect(server.calls.at(-1)?.method).toBe('DELETE');
  });

  it('reports a real initialize failure with the server message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ jsonrpc: '2.0', id: 'init', error: { code: -32600, message: 'unsupported protocol version' } })));
    await expect(mcpListTools({ remoteUrl: 'https://mcp.example.test', accessToken: 'tok' })).rejects.toThrow(/initialize failed \(200\): unsupported protocol version/);
  });
});
