/**
 * One-shot MCP tool CALLER — used when Archon's own server needs to invoke
 * a single tool directly (the flow engine's generic "Call a Tool" action
 * node). This is a different caller than the chat path: Anthropic/OpenAI's
 * Managed MCP talks to these servers directly for AI-driven tool calls;
 * this is for DETERMINISTIC calls Archon's own Node process makes on the
 * flow's behalf.
 *
 * For LISTING tools with schemas (design-time), reuse
 * `mcp/clients/streamable-http-client.ts`'s `mcpListTools` — no need to
 * duplicate that here.
 */
import { logger } from '../logger';

interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

async function rpc<T>(
  baseUrl: string,
  token: string,
  sessionId: string | undefined,
  body: Record<string, unknown>,
): Promise<{ result: T | undefined; sessionId: string | undefined }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
  const newSessionId = res.headers.get('mcp-session-id') ?? sessionId;
  const contentType = res.headers.get('content-type') ?? '';

  const raw = await res.text();
  let json: JsonRpcResponse<T> | undefined;
  if (contentType.includes('text/event-stream')) {
    const lines = raw.split('\n').filter(l => l.startsWith('data:'));
    const last = lines[lines.length - 1];
    if (last) json = JSON.parse(last.slice(5).trim());
  } else if (raw.trim()) {
    json = JSON.parse(raw);
  }

  if (!res.ok) {
    throw new Error(`MCP server ${baseUrl} returned ${res.status}: ${raw.slice(0, 300)}`);
  }
  if (json?.error) {
    throw new Error(`MCP error from ${baseUrl}: ${json.error.message}`);
  }
  return { result: json?.result, sessionId: newSessionId };
}

async function initSession(baseUrl: string, token: string): Promise<string> {
  const { sessionId } = await rpc(baseUrl, token, undefined, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'archon-server', version: '1.0' } },
  });
  if (!sessionId) throw new Error(`MCP server ${baseUrl} did not return a session id on initialize`);
  await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }).catch(() => null);
  return sessionId;
}

/** One-shot tool call. Returns the tool's text content, parsed as JSON when possible. */
export async function callMcpTool(baseUrl: string, token: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const sessionId = await initSession(baseUrl, token);
  const { result } = await rpc<{ content?: Array<{ type: string; text?: string }>; isError?: boolean }>(
    baseUrl, token, sessionId,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: args } },
  );
  const text = result?.content?.find(c => c.type === 'text')?.text;
  if (result?.isError) {
    throw new Error(text || `Tool ${toolName} returned an error`);
  }
  if (text === undefined) return null;
  try { return JSON.parse(text); } catch { return text; }
}

export function safeBaseUrl(url: string): string {
  const cleaned = url.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(cleaned)) {
    logger.warn({ url }, 'mcp_client_non_http_url');
  }
  return cleaned;
}
