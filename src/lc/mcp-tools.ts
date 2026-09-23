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
import { spillIfLarge } from './artifact-store';
import type { ResolvedMcpServer } from '../chat/adapters/shared';
import { ensureMcpServerAwake } from '../chat/adapters/shared';
import { invalidateRecordContext } from '../chat/record-context';
import jwt from 'jsonwebtoken';
import { verifyPlatformToken } from '../platform/token';

export interface LoadedMcpTools {
  tools: StructuredToolInterface[];
  /** Servers that were configured but could not be listed this turn. The
   *  runtime tells the MODEL about these: an agent that silently loses its
   *  tools does not fall silent, it improvises — live-confirmed, a user
   *  identity question was handed to a schema specialist because that was
   *  the only thing left on the list. Saying so is the honest degrade. */
  unavailable: string[];
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
//
// A HARD TTL PUT THE WHOLE HANDSHAKE ON THE TURN'S CRITICAL PATH.
//
// Measured on a warm host: the same question costs 11.2s on a cache miss
// and 3.4s on a hit -- a 7.7s swing that is entirely this connect, against
// a server whose plain /tools GET answers in 0.42s. With a flat 4-minute
// expiry, anyone who pauses mid-conversation pays that again, so the slow
// turns land on exactly the people who stopped to read the last answer.
//
// So expiry is two-stage. Inside FRESH_MS, serve and do nothing. Past it
// but inside STALE_MS, serve the cached tools IMMEDIATELY and refresh
// behind the turn -- tool lists change when someone edits an agent, which
// is rare and never urgent. Only a genuinely old or absent entry blocks,
// and a rotated token changes the cache key, so credentials can never be
// served stale.
const FRESH_MS = 4 * 60 * 1000;
const STALE_MS = 60 * 60 * 1000;
// A replaced client is not closed while a turn may still be calling its
// tools -- closing it out from under one turns a refresh into a failed
// tool call. Outliving any single turn is enough.
const CLOSE_GRACE_MS = 3 * 60 * 1000;
interface CacheEntry { loaded: LoadedMcpTools; realClose: () => Promise<void>; createdAt: number; tokenExpiresAt: number | null }
const toolCache = new Map<string, CacheEntry>();
/** Refreshes in progress, so N concurrent turns trigger one reconnect. */
const refreshing = new Set<string>();

function closeAfterGrace(realClose: () => Promise<void>): void {
  const t = setTimeout(() => { void realClose().catch(() => { /* best effort */ }); }, CLOSE_GRACE_MS);
  // Never hold the process open for a cleanup timer.
  if (typeof t === 'object' && t && 'unref' in t) (t as NodeJS.Timeout).unref();
}

// THE PLATFORM TOKEN CHANGED EVERY TURN, SO ITS TOOLS NEVER CACHED.
//
// The server's own tools are reached with a JWT minted per turn -- iat
// differs every second, sid per session -- and the key below used the
// token's tail. So every turn of the copilot, and every specialist it
// called, did a fresh MCP handshake to this very process, and none of the
// stale-while-revalidate work above ever applied to them. Key on WHO the
// token is for; whether the token itself is still good is a separate
// check at lookup, so a cached client never presents a dead one.
const TOKEN_SKEW_MS = 60_000;

function serverIdentity(s: ResolvedMcpServer): string {
  const p = verifyPlatformToken(s.token);
  return p ? `platform:${p.orgId}|${p.userId}|${p.agentApiName ?? ''}|${p.sessionId ?? ''}` : s.token.slice(-12);
}

/** When the earliest of these servers' tokens expires, or null if none say. */
function tokenExpiry(servers: ResolvedMcpServer[]): number | null {
  let min: number | null = null;
  for (const s of servers) {
    const d = jwt.decode(s.token) as { exp?: number } | null;
    if (d && typeof d.exp === 'number') { const at = d.exp * 1000; if (min === null || at < min) min = at; }
  }
  return min;
}

function cacheKey(servers: ResolvedMcpServer[]): string {
  return servers
    .map(s => `${s.name}|${s.url}|${serverIdentity(s)}|${[...s.allowedTools].sort().join(',')}|${JSON.stringify(s.headers ?? {})}`)
    .sort()
    .join('||');
}

export async function loadMcpTools(
  servers: ResolvedMcpServer[],
  opts: { deadlineAt?: number } = {},
): Promise<LoadedMcpTools> {
  const key = cacheKey(servers);
  let hit = toolCache.get(key);
  // A cached client presents the token it was built with. About to expire
  // means the next call would be refused: reconnect now with the fresh one
  // rather than serve a client that is about to fail.
  if (hit && hit.tokenExpiresAt !== null && hit.tokenExpiresAt - Date.now() < TOKEN_SKEW_MS) {
    toolCache.delete(key);
    closeAfterGrace(hit.realClose);
    hit = undefined;
  }
  const age = hit ? Date.now() - hit.createdAt : Infinity;

  if (hit && age < FRESH_MS) return hit.loaded;

  if (hit && age < STALE_MS) {
    // Off the critical path: this turn answers with the tools we already
    // have while the reconnect happens behind it.
    if (!refreshing.has(key)) {
      refreshing.add(key);
      void (async () => {
        try {
          const next = await connectAndLoad(servers);
          if (next.tools.length > 0) {
            const prev = toolCache.get(key);
            toolCache.set(key, {
              loaded: { ...next, close: async () => { /* cached — lifecycle owned by the cache */ } },
              realClose: next.close,
              createdAt: Date.now(),
              tokenExpiresAt: tokenExpiry(servers),
            });
            if (prev) closeAfterGrace(prev.realClose);
          } else {
            await next.close().catch(() => { /* nothing worth keeping */ });
          }
        } catch (err) {
          // Keep serving what we have. A host that is down should not also
          // cost us the tool list we already hold.
          logger.warn({ err: err instanceof Error ? err.message : err }, 'mcp_background_refresh_failed');
        } finally {
          refreshing.delete(key);
        }
      })();
    }
    return hit.loaded;
  }

  if (hit) {
    toolCache.delete(key);
    closeAfterGrace(hit.realClose);
  }

  const fresh = await connectAndLoad(servers, opts.deadlineAt);
  // Only cache loads that actually produced tools — caching a rate-limited
  // empty result would blind every turn for the TTL window.
  if (fresh.tools.length > 0) {
    const entry: CacheEntry = { loaded: { ...fresh, close: async () => { /* cached — lifecycle owned by the cache */ } }, realClose: fresh.close, createdAt: Date.now(), tokenExpiresAt: tokenExpiry(servers) };
    toolCache.set(key, entry);
    return entry.loaded;
  }
  return fresh;
}

/** A string argument that is exactly a template placeholder — the model
 *  copying "<the record's OwnerId>" / "<tomorrow's date>" out of its own
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
        '(001… is an Account). Look up the real Contact or Lead Id related to this record, ' +
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
/** A tool that writes, by the only thing every server and custom action
 *  has in common: what it calls itself. */
const WRITE_TOOL_RE = /create|update|delete|upsert|insert|patch|save|write|set[A-Z_]/i;
/** A Salesforce Id: 15 or 18 alphanumerics. A stray 15-char word matches
 *  too, harmlessly -- invalidation only bites on a key that ends in it. */
const SF_ID_RE = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

function salesforceIdsIn(value: unknown, depth = 0, out = new Set<string>()): Set<string> {
  if (depth > 3 || value === null || value === undefined) return out;
  if (typeof value === 'string') { if (SF_ID_RE.test(value)) out.add(value); return out; }
  if (Array.isArray(value)) { for (const v of value) salesforceIdsIn(v, depth + 1, out); return out; }
  if (typeof value === 'object') { for (const v of Object.values(value as Record<string, unknown>)) salesforceIdsIn(v, depth + 1, out); }
  return out;
}

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
        const raw = typeof result === 'string' ? result : JSON.stringify(result);
        // Phase 3: oversized results are stored by reference — the model
        // gets a compact summary + artifact handle instead of the payload.
        const out = spillIfLarge(t.name, raw);
        logger.info({ tool: t.name, ms: Date.now() - t0, args: argsLog, resultChars: raw.length, result: out.slice(0, 600) }, 'mcp_tool_call');
        // The record block the prompt carries is cached for a minute. After
        // a tool WRITES to a record, the next turn must see what it wrote,
        // not the values from before -- live, an agent read stale values
        // back and re-asked for answers it had just saved. Any tool whose
        // name says it writes, from any server or a custom Apex action, and
        // every Salesforce Id its arguments carry: no tool, server, object
        // or argument name is assumed here.
        if (WRITE_TOOL_RE.test(t.name)) {
          for (const id of salesforceIdsIn(args)) invalidateRecordContext(id);
        }
        return out;
      } catch (err) {
        logger.error({ tool: t.name, ms: Date.now() - t0, args: argsLog, err: err instanceof Error ? err.message : String(err) }, 'mcp_tool_call_failed');
        throw err;
      }
    },
    { name: t.name, description: t.description, schema: t.schema },
  ) as StructuredToolInterface;
}

/** Short, bounded retry for a host that is merely asleep.
 *
 *  MCP hosts spin down when idle and answer the first request slowly or not
 *  at all. One attempt turns "the server was waking up" into "this agent
 *  has no tools" for the whole turn. Deliberately far shorter than the
 *  Architect survey retry: a customer is waiting on this one, so it rides
 *  out a blip and then degrades honestly rather than holding the turn for a
 *  full cold start. The tool-list cache means only the first turn after an
 *  idle period pays even this. */
const LIST_RETRY_WAITS_MS = [1_500, 4_000];

/** Longest we will hold a turn waiting for sleeping hosts, and the clock
 *  we always leave the model to answer in. A Render free-tier wake is
 *  ~30s; 45 gives that room plus slack without ever being the reason a
 *  turn runs out of time. */
const WAKE_CEILING_MS = 45_000;
const MODEL_FLOOR_MS = 20_000;

async function connectAndLoad(servers: ResolvedMcpServer[], deadlineAt?: number): Promise<LoadedMcpTools> {
  const tools: StructuredToolInterface[] = [];
  const serverByTool = new Map<string, string>();
  const clients: MultiServerMCPClient[] = [];
  const unavailable: string[] = [];

  // WAKE THE HOSTS FIRST, ALL OF THEM AT ONCE.
  //
  // The retry below rides out a blip. It does not ride out a cold start:
  // a Render free-tier host takes ~30s to wake and those waits total 5.5s,
  // so the FIRST turn after any idle period lost every tool and the agent
  // read the connector notice out loud -- "I can't reach that right now,
  // try again shortly." Live-confirmed against the CRM server, which woke
  // in 31.6s while the turn gave up at 9.5s.
  //
  // ensureMcpServerAwake was written for the provider-hosted adapter path
  // and never wired into the graph runtime that replaced it. Concurrent,
  // so N servers cost one wake and not N, and it keeps its own 5-minute
  // warmth memo keyed by origin -- the same key the adapter path uses --
  // so only the first turn after idle pays anything at all.
  // Bounded by what the turn can actually spare. The wake spends the same
  // clock the budget is counting down, so an unbounded one could hand the
  // person the budget brake ("our team will follow up") instead of the
  // honest "try again shortly" -- a strictly worse answer. Leave the model
  // room to reply; if there isn't any, skip the wake and degrade exactly
  // as before.
  const spare = deadlineAt
    ? Math.min(WAKE_CEILING_MS, deadlineAt - Date.now() - MODEL_FLOOR_MS)
    : WAKE_CEILING_MS;
  if (spare > 0) {
    const origins = [...new Set(servers.flatMap(s => {
      try { return [new URL(s.url).origin]; } catch { return []; }
    }))];
    await Promise.race([
      Promise.all(origins.map(o => ensureMcpServerAwake(o))),
      new Promise<void>(r => setTimeout(r, spare)),
    ]);
  }

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
            headers: {
              Authorization: `Bearer ${s.token}`,
              // THIS SERVER HAS RUN ITS APPROVAL POLICY ON THIS CALL.
              //
              // Both MCP servers currently take a raw Salesforce token as
              // proof that the caller gated the write. The Metadata
              // server says so outright: its approval page is skipped
              // when APPROVAL_MODE=oauth-clients and the token is a
              // Salesforce one, which is exactly what Archon sends. That
              // assumption was false for anything reaching them from the
              // old provider-hosted path, where no gate existed at all.
              //
              // A header is an assertion, not a proof — but it is one a
              // bare stolen token cannot make, and it lets the servers
              // refuse writes from callers that have no gate. They ignore
              // it until REQUIRE_ARCHON_APPROVAL is turned on there, so
              // this can ship first and either order is safe.
              'X-Archon-Approval': 'granted',
              ...(s.headers ?? {}),
            },
          },
        },
        // Tool names must stay EXACTLY as the server publishes them —
        // allowedTools from Salesforce and the model's own calls both use
        // raw names, same as the provider-hosted setup enforced.
        prefixToolNameWithServerName: false,
        additionalToolNamePrefix: '',
      });
      let loaded: Awaited<ReturnType<typeof client.getTools>> | null = null;
      for (let attempt = 0; attempt <= LIST_RETRY_WAITS_MS.length; attempt++) {
        try {
          loaded = await client.getTools();
          break;
        } catch (err) {
          if (attempt === LIST_RETRY_WAITS_MS.length) throw err;
          logger.info(
            { server: s.name, attempt: attempt + 1, waitMs: LIST_RETRY_WAITS_MS[attempt] },
            'mcp_tools_list_retrying',
          );
          await new Promise(r => setTimeout(r, LIST_RETRY_WAITS_MS[attempt]));
        }
      }
      if (!loaded) throw new Error('tool listing returned nothing');
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
      unavailable.push(s.name);
    }
  }

  return {
    tools,
    unavailable,
    serverByTool,
    close: async () => {
      await Promise.allSettled(clients.map(c => c.close()));
    },
  };
}
