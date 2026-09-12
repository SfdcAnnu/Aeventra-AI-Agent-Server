/**
 * Shared helpers used by all chat adapters (Claude, OpenAI, later Gemini).
 *
 *   discoverAllowedTools — walks the agent graph, finds the connector node
 *                          downstream of the AI node, returns its
 *                          allowedTools list.
 *   buildSystemPrompt    — assembles the system message from the agent's
 *                          knowledgeBase + the AI node's systemPrompt +
 *                          record context.
 */
import { config } from '../../config';
import { logger } from '../../logger';
import { ConnectorsRepo } from '../../db/connectors.repo';
import { refreshGoogleToken } from '../../oauth/google';
import { refreshMicrosoftToken } from '../../oauth/microsoft';
import { refreshAccessToken as refreshSalesforceToken } from '../../oauth/salesforce';
import { hasReadyKbDocuments, retrieveKb, formatKbContext } from '../../kb/retriever';
import { decodeStoredResult } from '../tool-replay';
import type { AgentDefinition, AgentNode } from '../../types';
import type { ChatTurnRequest, EngineOverrideInput } from './types';
import type { Connector } from '@prisma/client';

/**
 * Return a FRESH access token for a connector row, refreshing when the
 * stored one is expired/near expiry. Google tokens live ~1 hour.
 */
export async function freshConnectorToken(row: Connector): Promise<string | null> {
  const SKEW_MS = 60_000;
  const UNKNOWN_EXPIRY_MS = 20 * 60 * 1000;
  let stale: boolean;
  if (row.tokenExpiresAt) {
    stale = row.tokenExpiresAt.getTime() - Date.now() < SKEW_MS;
  } else if (row.providerKey === 'salesforce_mcp') {
    // SF often omits expires_in and JWT access tokens live ~30 min —
    // refresh when the row hasn't been touched in a while.
    stale = Date.now() - row.updatedAt.getTime() > UNKNOWN_EXPIRY_MS;
  } else {
    stale = false;
  }
  if (!stale || !row.refreshToken) return row.accessToken ?? null;

  try {
    if (row.providerKey === 'gmail') {
      const tok = await refreshGoogleToken(row.refreshToken);
      const updated = await ConnectorsRepo.updateTokens(row.id, {
        accessToken:    tok.access_token,
        tokenExpiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null,
      });
      logger.info({ connectorId: row.id, provider: row.providerKey }, 'connector_token_refreshed');
      return updated.accessToken;
    }
    if (row.providerKey === 'salesforce_mcp') {
      const tok = await refreshSalesforceToken(row.refreshToken);
      const updated = await ConnectorsRepo.updateTokens(row.id, {
        accessToken:    tok.access_token,
        tokenExpiresAt: tok.expires_in ? new Date(Date.now() + Number(tok.expires_in) * 1000) : null,
        instanceUrl:    tok.instance_url ?? undefined,
      });
      logger.info({ connectorId: row.id, provider: row.providerKey }, 'connector_token_refreshed');
      return updated.accessToken;
    }
    if (row.providerKey === 'outlook') {
      // Microsoft ROTATES refresh tokens — persist the new one every time.
      const tok = await refreshMicrosoftToken(row.refreshToken);
      const updated = await ConnectorsRepo.updateTokens(row.id, {
        accessToken:    tok.access_token,
        refreshToken:   tok.refresh_token ?? undefined,
        tokenExpiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null,
      });
      logger.info({ connectorId: row.id, provider: row.providerKey }, 'connector_token_refreshed');
      return updated.accessToken;
    }
    return row.accessToken ?? null;   // other providers: use as-is until wired
  } catch (err) {
    logger.error({ err, connectorId: row.id, provider: row.providerKey }, 'connector_token_refresh_failed');
    return row.accessToken ?? null;   // let the MCP call surface the auth error
  }
}

// ── Multi-connector MCP server resolution ──────────────────────────
// Salesforce sends connectors[] each turn (provider, mcpServerUrl,
// allowedTools, connectorId). We attach the right token per provider:
//   • salesforce_mcp → the org's SF access token (OrgInstall)
//   • anything else  → the Connector row's token (Node-side DB)
// When connectors[] is absent (older Apex), fall back to the single
// env-configured Salesforce MCP server.

export interface ResolvedMcpServer {
  name:         string;      // unique server label for the LLM config
  url:          string;      // full .../mcp URL
  token:        string;      // bearer for that MCP server
  allowedTools: string[];    // empty = expose all tools
}

// ── allowedTools sanitization ───────────────────────────────────────
// Agents saved before the live-catalog change carry STALE tool names
// (list_sobjects, get_record, …). OpenAI enforces allowed_tools hard, so a
// zero-overlap list would hide EVERY tool from the model. We validate the
// selection against the server's public /tools catalog (cached 10 min):
//   • partial overlap → keep only the valid names
//   • zero overlap    → treat as legacy garbage: expose ALL tools + warn
//   • catalog fetch fails → pass through unchanged (can't judge)

const toolCatalogCache = new Map<string, { names: Set<string> | null; fetchedAt: number }>();
const CATALOG_TTL_MS = 10 * 60 * 1000;

async function fetchToolNames(baseUrl: string): Promise<Set<string> | null> {
  const cached = toolCatalogCache.get(baseUrl);
  if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return cached.names;
  let names: Set<string> | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6_000);
    const res = await fetch(`${baseUrl}/tools`, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const json = (await res.json()) as { tools?: Array<{ name?: string }> };
      names = new Set((json.tools ?? []).map(t => t.name).filter(Boolean) as string[]);
    }
  } catch { /* unreachable or no /tools — leave null */ }
  // Cache SUCCESS only. A failure here is usually a free-tier host mid-wake;
  // caching the null for 10 minutes made every turn in that window skip
  // validation AND told OpenAI to fetch a server we already knew was down.
  if (names !== null) toolCatalogCache.set(baseUrl, { names, fetchedAt: Date.now() });
  return names;
}

// ── cold-start absorption ───────────────────────────────────────────
// Free-tier MCP hosts (Render) sleep after idle. The model provider fetches
// each MCP server's tool list ITSELF with a short timeout and no retry, so a
// cold host surfaces as a hard turn-killing error (OpenAI: 424 Failed
// Dependency) even though the host would be fine 30s later. Before handing a
// URL to the provider, ping the host until it answers HTTP — any status
// beats a connection error/edge 5xx — and remember warmth briefly so warm
// paths cost one cache lookup.
const mcpAwakeAt = new Map<string, number>();
const MCP_AWAKE_TTL_MS = 5 * 60 * 1000;

async function ensureMcpServerAwake(base: string): Promise<void> {
  const last = mcpAwakeAt.get(base);
  if (last && Date.now() - last < MCP_AWAKE_TTL_MS) return;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      const res = await fetch(base, { signal: controller.signal });
      clearTimeout(timer);
      if (res.status < 500) {
        mcpAwakeAt.set(base, Date.now());
        if (attempt > 1) logger.info({ base, attempt }, 'mcp_server_woken');
        return;
      }
    } catch { /* connection refused / aborted — still waking */ }
    await new Promise(resolve => setTimeout(resolve, 3_000));
  }
  // Don't fail the turn from here — the provider's own fetch gets the last
  // word; by now the host has had ~55s of wake time.
  logger.warn({ base }, 'mcp_server_still_cold_after_wake_wait');
}

async function sanitizeAllowedTools(baseUrl: string, allowedTools: string[]): Promise<string[]> {
  if (!allowedTools || allowedTools.length === 0) return [];
  const names = await fetchToolNames(baseUrl);
  if (!names || names.size === 0) return allowedTools;   // can't validate
  const valid = allowedTools.filter(t => names.has(t));
  if (valid.length === 0) {
    logger.warn({ baseUrl, staleTools: allowedTools },
      'allowed_tools_all_stale_exposing_all — re-save the agent to pick fresh tool names');
    return [];
  }
  if (valid.length < allowedTools.length) {
    logger.warn({ baseUrl, dropped: allowedTools.filter(t => !names.has(t)) },
      'allowed_tools_partially_stale');
  }
  return valid;
}

/**
 * Resolve the bearer token for ONE provider — the same hybrid-auth rule
 * chat uses (personal Salesforce connection first, org fallback, PerUser
 * hard-fail), extracted so the flow engine's generic call_tool node can
 * reach a provider's MCP server without duplicating this logic.
 */
export async function resolveProviderToken(args: {
  orgId: string;
  userId: string;
  provider: string;
  connectorId?: string | null;
  accessMode?: string | null;
  sfAccessToken?: string | null;
}): Promise<string | null> {
  const { orgId, userId, provider, connectorId, accessMode, sfAccessToken } = args;
  if (provider === 'salesforce_mcp') {
    const personal = await ConnectorsRepo
      .getByOrgProviderAndUser(orgId, 'salesforce_mcp', userId)
      .catch(() => null);
    if (personal) {
      const token = await freshConnectorToken(personal);
      if (token) {
        logger.info({ orgId, userId }, 'sf_mcp_using_personal_connection');
        return token;
      }
    }
    if (accessMode === 'PerUser') {
      logger.warn({ orgId, userId }, 'sf_mcp_personal_connection_required');
      throw new Error('This agent runs with each user\'s own Salesforce access, and your account is not connected yet. Click "Connect my Salesforce" in the chat panel, then send your message again.');
    }
    return sfAccessToken ?? null;
  }
  if (connectorId) {
    const row = await ConnectorsRepo.getById(orgId, connectorId).catch(() => null);
    return row ? await freshConnectorToken(row) : null;
  }
  return null;
}

export async function resolveMcpServers(
  req: ChatTurnRequest,
  aiNode: AgentNode,
  sfAccessToken: string,
): Promise<ResolvedMcpServer[]> {
  const out: ResolvedMcpServer[] = [];

  if (req.connectors && req.connectors.length > 0) {
    // An agent may legitimately carry several catalog nodes on the SAME
    // provider (one per owning subagent) — Apex sends each as its own
    // connector entry. Handing the model provider N copies of one server
    // (salesforce_mcp, salesforce_mcp_2, …) means N tool-list fetches and N
    // chances for a cold host to kill the turn — merge them into one entry
    // first. allowedTools: an EMPTY list means unrestricted, so if any
    // duplicate is unrestricted the merged entry stays unrestricted;
    // otherwise union the restriction lists.
    const mergedByKey = new Map<string, (typeof req.connectors)[number]>();
    for (const c of req.connectors) {
      const key = `${c.provider}::${c.mcpServerUrl.replace(/\/+$/, '')}::${c.connectorId ?? ''}`;
      const prev = mergedByKey.get(key);
      if (!prev) {
        mergedByKey.set(key, {
          ...c,
          allowedTools: [...(c.allowedTools ?? [])],
          customTools: c.customTools ? [...c.customTools] : c.customTools,
        });
        continue;
      }
      const prevAllowed = prev.allowedTools ?? [];
      const currAllowed = c.allowedTools ?? [];
      prev.allowedTools = prevAllowed.length === 0 || currAllowed.length === 0
        ? []
        : [...new Set([...prevAllowed, ...currAllowed])];
      const prevCustom = prev.customTools ?? [];
      const extraCustom = (c.customTools ?? []).filter(t =>
        !prevCustom.some(p => p.type === t.type && p.name === t.name));
      if (prevCustom.length + extraCustom.length > 0) prev.customTools = [...prevCustom, ...extraCustom];
    }

    const seen = new Set<string>();
    for (const c of mergedByKey.values()) {
      const base = c.mcpServerUrl.replace(/\/+$/, '');
      let name = c.provider.replace(/[^a-zA-Z0-9_-]/g, '_');
      while (seen.has(name)) name = `${name}_2`;
      seen.add(name);

      let token: string | null;
      try {
        token = await resolveProviderToken({
          orgId: req.context.orgId, userId: req.context.userId,
          provider: c.provider, connectorId: c.connectorId, accessMode: c.accessMode, sfAccessToken,
        });
      } catch (err) {
        throw err; // PerUser hard-fail must still surface to the caller
      }
      if (!token) {
        logger.warn({ provider: c.provider, orgId: req.context.orgId },
          'mcp_connector_skipped_no_token');
        continue;
      }
      await ensureMcpServerAwake(base);
      let allowedTools = await sanitizeAllowedTools(base, c.allowedTools ?? []);

      // Org-specific custom tools (Apex actions / Flows) — the MCP server
      // registers them dynamically from the ?custom= query param and names
      // them {type}__{safeName}. Their names must ride along in
      // allowed_tools when a restriction list is active.
      let url = `${base}/mcp`;
      const custom = (c.customTools ?? []).filter(t =>
        (t.type === 'apex' || t.type === 'flow') && /^[a-zA-Z0-9_.]{1,255}$/.test(t.name));
      if (custom.length > 0) {
        url += `?custom=${encodeURIComponent(custom.map(t => `${t.type}:${t.name}`).join(','))}`;
        if (allowedTools.length > 0) {
          const customNames = custom.map(t =>
            `${t.type}__${t.name.replace(/[^a-zA-Z0-9_]/g, '_')}`.slice(0, 64));
          allowedTools = [...allowedTools, ...customNames];
        }
        logger.info({ provider: c.provider, customCount: custom.length }, 'mcp_custom_tools_attached');
      }

      out.push({ name, url, token, allowedTools });
    }
    return out;
  }

  // Legacy fallback — single Salesforce MCP from env
  if (config.salesforce.remoteMcpUrl) {
    const base = config.salesforce.remoteMcpUrl.replace(/\/+$/, '');
    const { allowedTools } = discoverAllowedTools(req.agent, aiNode);
    await ensureMcpServerAwake(base);
    out.push({
      name:  'salesforce',
      url:   `${base}/mcp`,
      token: sfAccessToken,
      allowedTools: await sanitizeAllowedTools(base, allowedTools),
    });
  }
  return out;
}

export function discoverAllowedTools(
  agent: AgentDefinition,
  aiNode: AgentNode,
): { allowedTools: string[]; catalogFound: boolean } {
  // Walk canvas connections downstream of the AI node
  const canvas = agent.canvasJson as { connections?: Array<{ fromIndex?: number; toIndex?: number }> } | undefined;
  const connections = canvas?.connections ?? [];

  const downstreamCatalog = agent.nodes.find(n =>
    n.nodeType === 'catalog' &&
    connections.some(c => {
      const from = agent.nodes[c.fromIndex ?? -1]?.id;
      const to   = agent.nodes[c.toIndex   ?? -1]?.id;
      return from === aiNode.id && to === n.id;
    }),
  );

  if (!downstreamCatalog) return { allowedTools: [], catalogFound: false };

  const cfg = downstreamCatalog.config ?? {};
  const allowedTools = Array.isArray(cfg.allowedTools) ? (cfg.allowedTools as string[]) : [];
  return { allowedTools, catalogFound: true };
}

/**
 * Real RAG retrieval, when the agent has indexed documents; null when it
 * doesn't (or a lookup fails) so the caller can fall back to the raw
 * Notes text — never breaks an agent that hasn't uploaded anything.
 */
async function buildKbBlock(
  orgId: string,
  agent: AgentDefinition,
  query: string,
  engineOverride?: EngineOverrideInput | null,
): Promise<string | null> {
  try {
    const has = await hasReadyKbDocuments(orgId, agent.apiName);
    if (!has) return null;
    const chunks = await retrieveKb({ orgId, agentApiName: agent.apiName, query, engineOverride });
    const block = formatKbContext(chunks);
    if (!block) return null;
    return 'KNOWLEDGE BASE (most relevant passages for this question):\n' + block;
  } catch (err) {
    logger.error({ err, orgId, agent: agent.apiName }, 'kb_retrieval_failed_falling_back');
    return null;
  }
}

/** Semantic deferral detector — catches replies that END on a promise of
 *  future work ("let me calculate… one moment, please") with nothing behind
 *  it. The structural narration guard can't see these (the response DOES
 *  end in a text block), yet to the customer they are a dead end — live-
 *  confirmed on the WhatsApp revival flow, where a "One moment, please."
 *  stall killed a negotiation. Checked against the trailing sentence only,
 *  so a reply that defers AND THEN answers doesn't false-positive. */
const DEFERRAL_TAIL_RE = /((one|just a) moment|hold on|please (hold|wait)|bear with me|let me (calculate|check|review|look|see|pull|find|get)|i(?:'|’)?ll (check|calculate|look|review|find|get back)|give me a (moment|second|minute))[^a-zA-Z0-9]*$/i;

// Broader promise-of-action detector for SHORT replies that are nothing
// but a deferral with trailing words — "Let me get that information for
// you." / "I will need to retrieve the line items…" slipped past the
// tail-anchored pattern above (live-confirmed: customer had to repeat
// their question). Deliberately excludes the customer-facing idiom
// "let me know". Only applied to short replies, so a long answer that
// happens to say "let me pull up X — here it is: …" never false-positives.
const DEFERRAL_PROMISE_RE = /\b(let me|allow me|i(?:'|’)?ll|i will( need to)?|i am going to|going to)\s+(retriev\w*|fetch\w*|calculat\w*|check\w*|review\w*|look\w*|pull\w*|find\w*|gather\w*|prepar\w*|get\b)/i;

export function isDeferralText(text: string): boolean {
  const trimmed = text.trim();
  if (DEFERRAL_TAIL_RE.test(trimmed.slice(-160))) return true;
  return trimmed.length < 260 && DEFERRAL_PROMISE_RE.test(trimmed);
}

/** Compact, model-facing summary of a persisted tool-result history row —
 *  folded into the adjacent assistant message by both adapters' history
 *  mappers so exact record Ids/values survive into later turns (the same
 *  cure ChatPanel applies client-side on the WS path). */
export function summarizeToolHistoryEntry(
  m: { content: string; toolCallsJson?: string | null; toolResultsJson?: string | null },
  /** Chars to keep. The caller normally budgets by recency first
   *  (chat/tool-replay.ts) and passes already-sized text; this flat cap is
   *  the floor for callers that don't. */
  maxChars = 600,
): string | null {
  let name = 'tool';
  try {
    const j = JSON.parse(m.toolCallsJson ?? '{}') as { name?: string };
    if (j.name) name = j.name;
  } catch { /* keep default */ }
  const raw = (m.content ?? '').trim() || (m.toolResultsJson ?? '').trim();
  if (!raw) return null;
  // Apex stores results double-encoded (JSON.serialize of a String) — the
  // escaped form costs tokens in backslashes alone.
  const output = decodeStoredResult(raw);
  const clipped = output.length > maxChars ? output.slice(0, maxChars) + '…' : output;
  return `[Earlier tool result — ${name}: ${clipped}\nReuse exact Ids/values from here in later turns; never invent or truncate them.]`;
}

/** Whitespace normalization so the stable prefix is byte-identical on
 *  every request (prompt-cache rule: a single drifting byte turns every
 *  cache read into a paid cache write). */
export function normalizePromptText(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .split('\n').map(line => line.replace(/[ \t]+$/g, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface SystemPromptParts {
  /** Byte-identical for every turn of this agent version — the cacheable
   *  prefix. Identity, business rules, instructions, platform rules. */
  stable: string;
  /** Varies per turn/session — date, retrieved KB, memory, record context.
   *  Always placed BELOW the cache breakpoint. */
  volatile: string;
}

/** The cache-aware split. NOTHING volatile may enter `stable`: the old
 *  layout put a per-second timestamp as line two of the prompt, which
 *  would have made every request a cache write and none a read. */
export async function buildSystemPromptParts(
  agent: AgentDefinition,
  aiNode: AgentNode,
  ctx:   ChatTurnRequest['context'],
  query: string,
  engineOverride?: EngineOverrideInput | null,
  memoryPreamble?: string | null,
  extraContext?: string | null,
): Promise<SystemPromptParts> {
  const config = (aiNode.config as { systemPrompt?: string }) ?? {};

  const stableParts: string[] = [];
  // Identity only — the name is the client's own agent data. No channel,
  // modality, or platform assumptions here (a voice agent runs the same
  // runtime); everything about WHAT the agent is comes from the client's
  // instructions screen (the AI node's systemPrompt).
  //stableParts.push(`You are ${agent.name}.`);
  // Business Rules/Knowledge (the agent's own Notes field) and uploaded/
  // indexed KB documents are different kinds of content — hand-written
  // instructions vs. searchable reference material — and are additive.
 
  if (config.systemPrompt && config.systemPrompt.trim().length > 0) {
    stableParts.push(config.systemPrompt);
  }
   if (agent.knowledgeBase && agent.knowledgeBase.trim().length > 0) {
    stableParts.push('BUSINESS RULES / KNOWLEDGE (always apply these):\n' + agent.knowledgeBase);
  }
  // Runtime mechanics only — no provider assumptions, no style opinions
  // (tone/verbosity belong to each agent's own instructions).
  stableParts.push(
    'You have access to the tools connected to this agent. Use them to look up real data or take actions when ' +
    'the conversation calls for it — never invent a value a tool can fetch. When several tool calls are ' +
    'independent of each other, make them in ONE response — they execute in parallel.',
  );
  stableParts.push(
    'CRITICAL — never end your turn on a narration-only sentence. ' +
    'A phrase like "let me check that," "let me get that updated," or "let me look that up" is a placeholder, ' +
    'not a reply — the user cannot see that you called a tool or whether it worked. ' +
    'If you say anything like that before calling a tool, calling the tool is NOT the end of your turn: ' +
    'you MUST continue and produce a real final sentence after the tool result comes back. ' +
    'For a lookup: give the actual information, or (if nothing useful was found) ask the user directly for what you still need. ' +
    'For an action (creating or updating a record): CONFIRM WHAT HAPPENED — state plainly that it\'s done and ' +
    'summarize the result (e.g. "Confirmed — closing this at $X" or "Done, someone will reach out about that shortly"), ' +
    'or if the tool call failed, say so and what you\'ll do instead. Silently stopping after a narration sentence, ' +
    'with or without a successful tool call behind it, is always wrong.',
  );

  const volatileParts: string[] = [];
  // Models have no clock — without this, any "tomorrow"/"next week" they
  // compute (Task due dates, Event start times) lands on a training-era
  // date (live-confirmed: an Event scheduled for 2023). Lives BELOW the
  // cache breakpoint precisely because it changes every second.
  volatileParts.push(`Current date and time (UTC): ${new Date().toISOString()}`);
  const kbBlock = await buildKbBlock(ctx.orgId, agent, query, engineOverride);
  if (kbBlock) volatileParts.push(kbBlock);
  // System-computed facts — deterministic values the model must use
  // verbatim instead of computing its own.
  if (extraContext && extraContext.trim().length > 0) volatileParts.push(extraContext);
  // Session memory (facts + summary of older turns) — see chat/memory.ts.
  if (memoryPreamble && memoryPreamble.trim().length > 0) volatileParts.push(memoryPreamble);
  if (ctx.recordContextId) {
    // Record anchoring — a runtime FACT (which record this session is
    // attached to), phrased modality-neutrally: works for an embedded
    // widget, WhatsApp, or a voice call alike.
    volatileParts.push(
      `This conversation is anchored to the ${ctx.recordContextType ?? 'record'} with Id ${ctx.recordContextId}. ` +
      `Use this record as the context for lookups and actions unless told otherwise.`,
    );
  }

  return {
    stable: normalizePromptText(stableParts.join('\n\n')),
    volatile: normalizePromptText(volatileParts.join('\n\n')),
  };
}

/** Joined form for callers that don't need the cache split (legacy
 *  adapters, the agent generator). Same content, same order. */
export async function buildSystemPrompt(
  agent: AgentDefinition,
  aiNode: AgentNode,
  ctx:   ChatTurnRequest['context'],
  query: string,
  engineOverride?: EngineOverrideInput | null,
  memoryPreamble?: string | null,
  extraContext?: string | null,
): Promise<string> {
  const parts = await buildSystemPromptParts(agent, aiNode, ctx, query, engineOverride, memoryPreamble, extraContext);
  return parts.volatile ? `${parts.stable}\n\n${parts.volatile}` : parts.stable;
}
