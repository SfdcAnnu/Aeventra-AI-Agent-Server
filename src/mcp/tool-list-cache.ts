/**
 * Cached MCP tool-list lookups.
 *
 * Every mcpListTools() opens a FRESH MCP session — initialize, notify,
 * tools/list — so three HTTP calls per lookup. Design-time surfaces ask
 * for tool lists often (the Connectors catalog, the tool pickers, the
 * Architect's Org Surveyor), and the hosted MCP servers rate-limit:
 * live-confirmed as `MCP initialize failed (429): Too Many Requests`,
 * which surfaced to the client as a bare 502.
 *
 * This is the same fix the chat runtime already has (lc/mcp-tools.ts's
 * 4-minute toolset cache), applied to the design-time path:
 *   - short TTL cache keyed by server URL + token identity
 *   - in-flight dedup, so N concurrent callers make ONE session
 *   - a 429 is remembered briefly, so a rate-limited server is not
 *     hammered further while it is asking us to back off
 *
 * Tool lists change when an admin changes a connector, not per second —
 * minutes of staleness is the right trade against being throttled.
 */
import { mcpListTools } from './clients/streamable-http-client';
import { logger } from '../logger';

const TTL_MS = 4 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;

export interface CachedTool {
  name: string;
  description: string;
  inputSchema?: unknown;
}

interface Entry {
  tools: CachedTool[];
  expiresAt: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<CachedTool[]>>();
const cooldown = new Map<string, number>();

/** Thrown when the MCP host is asking us to slow down — callers should
 *  say so in the client's vocabulary, not surface a provider error. */
export class McpRateLimited extends Error {
  constructor(public readonly retryAfterMs: number) {
    super('The tool server is busy right now. It should answer again in under a minute.');
  }
}

function keyOf(remoteUrl: string, accessToken: string): string {
  return `${remoteUrl}|${accessToken.slice(-12)}`;
}

export function invalidateToolList(remoteUrl: string, accessToken: string): void {
  cache.delete(keyOf(remoteUrl, accessToken));
}

export async function listToolsCached(opts: {
  remoteUrl: string;
  accessToken: string;
  /** Skip the cache read (still populates it). For an explicit refresh. */
  force?: boolean;
}): Promise<CachedTool[]> {
  const key = keyOf(opts.remoteUrl, opts.accessToken);
  const now = Date.now();

  if (!opts.force) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) return hit.tools;
  }

  const until = cooldown.get(key);
  if (until && until > now) {
    // Serve stale rather than fail, if we have anything at all.
    const stale = cache.get(key);
    if (stale) return stale.tools;
    throw new McpRateLimited(until - now);
  }

  const running = inflight.get(key);
  if (running) return running;

  const p = mcpListTools({ remoteUrl: opts.remoteUrl, accessToken: opts.accessToken })
    .then(tools => {
      const mapped: CachedTool[] = tools.map(t => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: (t as { inputSchema?: unknown }).inputSchema,
      }));
      cache.set(key, { tools: mapped, expiresAt: Date.now() + TTL_MS });
      cooldown.delete(key);
      return mapped;
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (/\b429\b|too many requests/i.test(msg)) {
        cooldown.set(key, Date.now() + RATE_LIMIT_COOLDOWN_MS);
        logger.warn({ remoteUrl: opts.remoteUrl }, 'mcp_tool_list_rate_limited');
        const stale = cache.get(key);
        if (stale) return stale.tools; // stale beats nothing
        throw new McpRateLimited(RATE_LIMIT_COOLDOWN_MS);
      }
      throw err;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, p);
  return p;
}
