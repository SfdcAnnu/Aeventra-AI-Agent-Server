/**
 * /platform — the Archon server as an MCP server (Streamable HTTP,
 * stateless: one MCP server object per request, closed with the response).
 *
 *   GET  /platform         wake ping (the runtime probes a base URL before listing)
 *   GET  /platform/tools   catalogue, the shape the runtime's allowed-tools check reads
 *   POST /platform/mcp     the MCP endpoint; bearer = per-turn platform token
 *
 * Every tool call runs as the principal inside the token — see token.ts.
 */
import { Router, type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { logger } from '../logger';
import { PLATFORM_TOOLS, platformToolCatalogue } from './tools';
import { verifyPlatformToken, type PlatformPrincipal } from './token';

export const platformRouter = Router();

platformRouter.get('/platform', (_req, res) => {
  res.json({ ok: true, name: 'archon-platform', mcp: '/platform/mcp' });
});

platformRouter.get('/platform/tools', (_req, res) => {
  const tools = platformToolCatalogue();
  res.json({ count: tools.length, tools });
});

function principalOf(req: Request): PlatformPrincipal | null {
  const header = req.header('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return null;
  return verifyPlatformToken(header.slice('Bearer '.length).trim());
}

function buildServer(principal: PlatformPrincipal): McpServer {
  const server = new McpServer({ name: 'archon-platform', version: '1.0.0' });
  for (const t of PLATFORM_TOOLS) {
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: { readOnlyHint: t.readOnly, destructiveHint: !t.readOnly, idempotentHint: t.readOnly, openWorldHint: false },
      },
      async (args: Record<string, unknown>) => {
        try {
          const r = await t.handler(args as never, principal);
          return { content: [{ type: 'text' as const, text: r.text }], structuredContent: r.structured, isError: r.isError === true };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn({ tool: t.name, orgId: principal.orgId, err: message }, 'platform_tool_failed');
          return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
        }
      },
    );
  }
  return server;
}

async function handleMcp(req: Request, res: Response): Promise<void> {
  const principal = principalOf(req);
  if (!principal) {
    res.status(401).json({ error: 'invalid_token', error_description: 'A platform turn token is required.' });
    return;
  }
  const server = buildServer(principal);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error({ err, orgId: principal.orgId }, 'platform_mcp_request_failed');
    if (!res.headersSent) res.status(500).json({ error: 'platform_mcp_failed' });
  }
}

platformRouter.post('/platform/mcp', handleMcp);
platformRouter.get('/platform/mcp', (_req, res) => {
  res.status(405).json({ error: 'method_not_allowed', error_description: 'Stateless endpoint: POST JSON-RPC to /platform/mcp.' });
});
platformRouter.delete('/platform/mcp', (_req, res) => {
  res.status(405).json({ error: 'method_not_allowed' });
});
