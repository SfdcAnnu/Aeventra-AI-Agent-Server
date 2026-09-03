/**
 * Client-side MCP tool loading — THE architectural difference from the
 * original server. There, the model PROVIDER connected to each MCP server
 * itself (OpenAI Responses `type:'mcp'`, Claude MCP connector) and executed
 * tools provider-side. Here, WE are the MCP client: connect to each
 * resolved server (same URLs/tokens/allowedTools resolveMcpServers already
 * produces, including the ?custom= Apex/Flow registration), pull the tool
 * list as LangChain StructuredTools, and LangGraph's ToolNode executes
 * calls locally. Provider-agnostic by construction — the same tool objects
 * bind to OpenAI, Anthropic, or Gemini models unchanged.
 */
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { logger } from '../logger';
import type { ResolvedMcpServer } from '../chat/adapters/shared';

export interface LoadedMcpTools {
  tools: StructuredToolInterface[];
  /** raw tool name → server label, for ToolCallSummary.serverName. */
  serverByTool: Map<string, string>;
  close: () => Promise<void>;
}

// ── Connection/tool cache ────────────────────────────────────────────
// Connecting per turn opened 2+ fresh MCP sessions every message (root +
// subagent) — enough for the MCP host's rate limiter to answer 429 on a
// busy conversation (live-confirmed). Cache the loaded toolset per exact
// server config (url+token+allowedTools) for a few minutes; expired
// entries close their clients in the background. Single-instance host, so
// an in-process Map is the right size of solution.
const CACHE_TTL_MS = 4 * 60 * 1000;
interface CacheEntry { loaded: LoadedMcpTools; realClose: () => Promise<void>; createdAt: number }
const toolCache = new Map<string, CacheEntry>();

function cacheKey(servers: ResolvedMcpServer[]): string {
  return servers
    .map(s => `${s.name}|${s.url}|${s.token.slice(-12)}|${[...s.allowedTools].sort().join(',')}`)
    .sort()
    .join('||');
}

export async function loadMcpTools(servers: ResolvedMcpServer[]): Promise<LoadedMcpTools> {
  const key = cacheKey(servers);
  const hit = toolCache.get(key);
  if (hit && Date.now() - hit.createdAt < CACHE_TTL_MS) {
    return hit.loaded;
  }
  if (hit) {
    toolCache.delete(key);
    void hit.realClose().catch(() => { /* stale client cleanup only */ });
  }

  const fresh = await connectAndLoad(servers);
  // Only cache loads that actually produced tools — caching a rate-limited
  // empty result would blind every turn for the TTL window.
  if (fresh.tools.length > 0) {
    const entry: CacheEntry = { loaded: { ...fresh, close: async () => { /* cached — lifecycle owned by the cache */ } }, realClose: fresh.close, createdAt: Date.now() };
    toolCache.set(key, entry);
    return entry.loaded;
  }
  return fresh;
}

/** A string argument that is exactly a template placeholder — the model
 *  copying "<Opportunity OwnerId>" / "<tomorrow's date>" out of its own
 *  instructions into a real write (live-confirmed on a Task create). */
const PLACEHOLDER_VALUE_RE = /"<[^">]{1,60}>"/;

/** Pre-flight argument checks that turn cryptic Salesforce integrity
 *  errors into self-correctable instructions (standard-object semantics,
 *  nothing agent-specific). Live-confirmed: an Account Id (001…) passed as
 *  WhoId killed an Event create with FIELD_INTEGRITY_EXCEPTION. */
function argProblem(args: unknown): string | null {
  const s = JSON.stringify(args);
  if (PLACEHOLDER_VALUE_RE.test(s)) {
    return 'REJECTED: one or more arguments are template placeholders like "<Contact Id>" or "<tomorrow\'s date>". ' +
      'Look up the real values first (soqlQuery / getRelatedRecords, and compute real dates from the current date ' +
      'in your instructions), then call this tool again with actual values.';
  }
  const body = (args as { body?: Record<string, unknown> })?.body;
  if (body) {
    const whoId = body.WhoId;
    if (typeof whoId === 'string' && whoId.length >= 15 && !/^(003|00Q)/.test(whoId)) {
      return `REJECTED: WhoId "${whoId}" is not a Contact (003…) or Lead (00Q…) Id — it looks like a different object ` +
        '(001… is an Account). Query the Opportunity\'s ContactId or OpportunityContactRole for the real Contact Id, ' +
        'then call this tool again.';
    }
    const ownerId = body.OwnerId;
    if (typeof ownerId === 'string' && ownerId.length >= 15 && !/^005/.test(ownerId)) {
      return `REJECTED: OwnerId "${ownerId}" is not a User Id (005…). Use the record's real OwnerId, then retry.`;
    }
  }
  return null;
}

/** Wrap a loaded MCP tool: pre-flight arg checks bounce bad calls back to
 *  the model as self-correctable errors, and every call is logged
 *  (truncated) so Render shows exactly what each tool was asked and
 *  answered. */
function rejectPlaceholderArgs(t: StructuredToolInterface): StructuredToolInterface {
  return tool(
    async (args: unknown) => {
      const problem = argProblem(args);
      const argsLog = JSON.stringify(args).slice(0, 600);
      if (problem) {
        logger.warn({ tool: t.name, args: argsLog, problem: problem.slice(0, 200) }, 'mcp_tool_call_rejected');
        return problem;
      }
      const t0 = Date.now();
      try {
        const result = await t.invoke(args as never);
        const resultLog = (typeof result === 'string' ? result : JSON.stringify(result)).slice(0, 600);
        logger.info({ tool: t.name, ms: Date.now() - t0, args: argsLog, result: resultLog }, 'mcp_tool_call');
        return result;
      } catch (err) {
        logger.error({ tool: t.name, ms: Date.now() - t0, args: argsLog, err: err instanceof Error ? err.message : String(err) }, 'mcp_tool_call_failed');
        throw err;
      }
    },
    { name: t.name, description: t.description, schema: t.schema },
  ) as StructuredToolInterface;
}

async function connectAndLoad(servers: ResolvedMcpServer[]): Promise<LoadedMcpTools> {
  const tools: StructuredToolInterface[] = [];
  const serverByTool = new Map<string, string>();
  const clients: MultiServerMCPClient[] = [];

  // One client per server (not one multi-client) so each server's
  // allowedTools filter applies to ITS tools only, and one cold/broken
  // server skips instead of failing the whole load.
  for (const s of servers) {
    try {
      const client = new MultiServerMCPClient({
        mcpServers: {
          [s.name]: {
            transport: 'http',
            url: s.url,
            headers: { Authorization: `Bearer ${s.token}` },
          },
        },
        // Tool names must stay EXACTLY as the server publishes them —
        // allowedTools from Salesforce and the model's own calls both use
        // raw names, same as the provider-hosted setup enforced.
        prefixToolNameWithServerName: false,
        additionalToolNamePrefix: '',
      });
      const loaded = await client.getTools();
      clients.push(client);
      const allowed = new Set(s.allowedTools);
      let kept = 0;
      for (const t of loaded) {
        if (allowed.size > 0 && !allowed.has(t.name)) continue;
        if (serverByTool.has(t.name)) {
          logger.warn({ tool: t.name, server: s.name }, 'mcp_tool_name_collision_skipped');
          continue;
        }
        serverByTool.set(t.name, s.name);
        tools.push(rejectPlaceholderArgs(t));
        kept++;
      }
      logger.info({ server: s.name, total: loaded.length, kept }, 'mcp_tools_loaded');
    } catch (err) {
      // Mirror of the original's degrade-don't-die stance on cold hosts:
      // a server that can't be reached loses ITS tools for this turn only.
      logger.error({ server: s.name, url: s.url, err: err instanceof Error ? err.message : err }, 'mcp_tools_load_failed');
    }
  }

  return {
    tools,
    serverByTool,
    close: async () => {
      await Promise.allSettled(clients.map(c => c.close()));
    },
  };
}
