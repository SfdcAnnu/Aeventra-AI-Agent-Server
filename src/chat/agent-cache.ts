/**
 * In-memory cache for AgentDefinition loads, keyed by (orgId, apiName).
 *
 * Every chat turn calls loadAgentDefinition() to pull the agent + all its
 * nodes from Salesforce. That's 2 SOQL calls per turn and typically the
 * single biggest latency source on the request-path.
 *
 * We cache the result in RAM with a short TTL (60 s) and pending-promise
 * dedup so 20 concurrent turns for the same agent do 1 SF fetch, not 20.
 *
 * Staleness policy:
 *   • Admins editing the agent Canvas in the portal expect updates to
 *     appear on the NEXT chat turn. 60 s TTL means at most a minute of
 *     stale reads — acceptable for chat, and admins can force-refresh
 *     via the "Save" flow which calls invalidate() below.
 */
import type { Connection } from 'jsforce';
import { loadAgentDefinition } from '../salesforce/client';
import type { AgentDefinition } from '../types';
import { logger } from '../logger';

//
// A FLAT 60s EXPIRY PUT BOTH SOQL CALLS BACK ON ALMOST EVERY REAL TURN.
//
// People type slower than that. Two messages a minute apart -- ordinary
// pacing for a WhatsApp qualification -- missed the cache every time and
// paid the reload before the turn clock had even started, which is where
// the biggest unexplained slice of a warm turn turned out to be hiding.
//
// So expiry is two-stage, the same shape as the MCP tool cache. Inside
// FRESH_MS, serve. Past it but inside STALE_MS, serve what we have
// IMMEDIATELY and reload behind the turn. An admin's edit still shows up
// on the next turn but one, and the Save flow's invalidate() below still
// makes it show up on the very next turn, so the staleness promise above
// is kept where it matters and the reload stops being the person's wait.
const FRESH_MS = 60_000;
const STALE_MS = 30 * 60_000;

interface CacheEntry {
  data:       AgentDefinition;
  expiresAt:  number;   // fresh until
  staleUntil: number;   // servable-while-refreshing until
}

const cache:   Map<string, CacheEntry>                    = new Map();
const pending: Map<string, Promise<AgentDefinition | null>> = new Map();

function key(orgId: string, apiName: string): string {
  return `${orgId}::${apiName}`;
}

function reload(k: string, orgId: string, apiName: string, conn: Connection): Promise<AgentDefinition | null> {
  const p = loadAgentDefinition(apiName, conn)
    .then(row => ensureSystemAgent(orgId, apiName, conn, row))
    .then(row => {
      if (row) {
        const now = Date.now();
        cache.set(k, { data: row, expiresAt: now + FRESH_MS, staleUntil: now + STALE_MS });
      }
      return row;
    })
    .finally(() => {
      pending.delete(k);
    });
  pending.set(k, p);
  return p;
}

export const AgentCache = {
  async load(orgId: string, apiName: string, conn: Connection): Promise<AgentDefinition | null> {
    const k = key(orgId, apiName);
    const hit = cache.get(k);
    const now = Date.now();
    if (hit && hit.expiresAt > now) return hit.data;

    if (hit && hit.staleUntil > now) {
      // Off the critical path: answer with the definition we hold while
      // the reload runs behind the turn. One reload, however many turns
      // arrive while it is in flight.
      if (!pending.has(k)) {
        reload(k, orgId, apiName, conn).catch(err => {
          // Keep serving what we have -- Salesforce being slow should not
          // also cost us the definition we already loaded from it.
          logger.warn({ orgId, apiName, err: (err as Error).message }, 'agent_cache_background_reload_failed');
        });
      }
      return hit.data;
    }

    const inflight = pending.get(k);
    if (inflight) return inflight;
    return reload(k, orgId, apiName, conn);
  },

  /** Called after an admin saves the agent so next chat turn sees fresh data. */
  invalidate(orgId: string, apiName: string): void {
    cache.delete(key(orgId, apiName));
  },

  invalidateOrg(orgId: string): void {
    for (const k of cache.keys()) {
      if (k.startsWith(`${orgId}::`)) cache.delete(k);
    }
  },

  clear(): void {
    cache.clear();
    pending.clear();
  },
};

/**
 * A platform-shipped agent is created in the org the first time it is
 * asked for, and a managed one is rewritten when the shipped version is
 * newer than the org's copy — so a fresh org has the copilot on first
 * use, and a server release updates it without anyone clicking sync.
 * Imported lazily: the sync module imports this cache.
 */
async function ensureSystemAgent(orgId: string, apiName: string, conn: Connection, row: AgentDefinition | null): Promise<AgentDefinition | null> {
  const { systemAgentSpec } = await import('../platform/agents/registry');
  const spec = systemAgentSpec(apiName);
  if (!spec) return row;
  const managed = spec.managed !== false;
  const orgVersion = (row?.canvasJson as { system?: { version?: number } } | undefined)?.system?.version ?? 0;
  const needs = !row || (managed && orgVersion < spec.version);
  if (!needs) return row;
  try {
    const { syncSystemAgent } = await import('../platform/system-agents');
    const r = await syncSystemAgent(conn, orgId, spec);
    logger.info({ orgId, apiName, created: r.created, written: r.written, version: spec.version }, 'system_agent_ensured');
    return await loadAgentDefinition(apiName, conn);
  } catch (err) {
    logger.error({ orgId, apiName, err: (err as Error).message }, 'system_agent_ensure_failed');
    return row;
  }
}
