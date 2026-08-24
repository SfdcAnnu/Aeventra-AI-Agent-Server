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

const TTL_MS = 60_000;

interface CacheEntry {
  data:      AgentDefinition;
  expiresAt: number;
}

const cache:   Map<string, CacheEntry>                    = new Map();
const pending: Map<string, Promise<AgentDefinition | null>> = new Map();

function key(orgId: string, apiName: string): string {
  return `${orgId}::${apiName}`;
}

export const AgentCache = {
  async load(orgId: string, apiName: string, conn: Connection): Promise<AgentDefinition | null> {
    const k = key(orgId, apiName);
    const hit = cache.get(k);
    if (hit && hit.expiresAt > Date.now()) return hit.data;

    const inflight = pending.get(k);
    if (inflight) return inflight;

    const p = loadAgentDefinition(apiName, conn)
      .then(row => {
        if (row) cache.set(k, { data: row, expiresAt: Date.now() + TTL_MS });
        return row;
      })
      .finally(() => {
        pending.delete(k);
      });
    pending.set(k, p);
    return p;
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
