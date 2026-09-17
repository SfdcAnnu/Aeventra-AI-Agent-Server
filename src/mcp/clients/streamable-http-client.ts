/**
 * Minimal MCP client — only used by /api/connectors/:id/tools so the properties
 * panel can show a list of allowed tools for the admin to tick.
 *
 * For actual chat tool execution, we no longer own the MCP session — Claude /
 * OpenAI talk to the MCP server directly via their Managed MCP features.
 */
import { logger } from '../../logger';

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO      = { name: 'synapse-portal', version: '0.1.0' };

export interface RemoteTool {
  name:         string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id?:     string | number;
  result?: T;
  error?:  { code: number; message: string };
}

export async function mcpListTools(opts: {
  remoteUrl:   string;
  accessToken: string;
}): Promise<RemoteTool[]> {
  const url = `${opts.remoteUrl.replace(/\/+$/, '')}/mcp`;
  const auth = { Authorization: `Bearer ${opts.accessToken}` };

  // 1. Initialize
  const initRes = await fetch(url, {
    method:  'POST',
    headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id:      'init',
      method:  'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
    }),
  });
  // A server MAY issue a session id; a stateless one (the 2026-07-28 shape,
  // and the SDK v2 default) never does, and that is not a failure. Judge
  // initialize by its body — JSON or an SSE frame — not by the header.
  const sessionId = initRes.headers.get('mcp-session-id') ?? '';
  const initText = await initRes.text();
  const init: JsonRpcResponse<{ protocolVersion?: string }> = initText.trimStart().startsWith('event:')
    ? parseSseFrame(initText)
    : JSON.parse(initText || '{}');
  if (!initRes.ok || init.error || !init.result?.protocolVersion) {
    throw new Error(`MCP initialize failed (${initRes.status}): ${init.error?.message ?? initText.slice(0, 300)}`);
  }
  const session: Record<string, string> = sessionId ? { 'mcp-session-id': sessionId } : {};

  // 2. Fire-and-forget notification
  await fetch(url, {
    method:  'POST',
    headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...session },
    body:    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }).catch(() => null);

  // 3. tools/list
  const listRes = await fetch(url, {
    method:  'POST',
    headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...session },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 'list', method: 'tools/list' }),
  });
  const listText = await listRes.text();
  const parsed: JsonRpcResponse<{ tools: RemoteTool[] }> = listText.trimStart().startsWith('event:')
    ? parseSseFrame(listText)
    : JSON.parse(listText || '{}');

  if (parsed.error) throw new Error(`tools/list failed: ${parsed.error.message}`);

  // 4. Best-effort close — only a session can be closed
  if (sessionId) await fetch(url, { method: 'DELETE', headers: { ...auth, 'mcp-session-id': sessionId } }).catch(() => null);

  logger.info({ toolCount: parsed.result?.tools?.length ?? 0 }, 'mcp_list_tools_done');
  return parsed.result?.tools ?? [];
}

function parseSseFrame<T>(raw: string): JsonRpcResponse<T> {
  const line = raw.split('\n').find(l => l.startsWith('data:'));
  if (!line) throw new Error('Empty SSE frame');
  return JSON.parse(line.slice(5).trim()) as JsonRpcResponse<T>;
}
