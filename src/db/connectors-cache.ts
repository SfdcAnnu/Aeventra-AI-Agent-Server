/**
 * The personal-connector lookup, cached.
 *
 * resolveProviderToken asks Postgres for the caller's own Salesforce
 * connection on EVERY turn: one indexed findFirst that measured 465-469ms
 * three times over -- on a fresh process, on a warm one, before and after
 * a deploy. Not warmup, not the query plan; that is simply what one round
 * trip to this database costs from where the server runs. It was the
 * single largest server-side cost on a warm turn once the other caches
 * were hitting.
 *
 * The row changes when someone connects, reconnects or disconnects, and
 * when a token refresh writes back -- all of which go through this
 * process, so each of those sites either puts the new row or drops the
 * org's entries. Freshness of the TOKEN is not this cache's job:
 * freshConnectorToken still reads tokenExpiresAt/updatedAt off whatever
 * row it is handed, which is exactly why a refreshed row must be put()
 * back here -- serving the pre-refresh row would make that check trip on
 * every turn and turn one saved read into an OAuth round trip per turn.
 *
 * A NULL is cached too. A person with no personal connection falls back
 * to the org token, and without this they would pay the lookup forever;
 * the null is dropped the moment upsertPending creates their row.
 */
import type { Connector } from '@prisma/client';
import { ConnectorsRepo } from './connectors.repo';

const TTL_MS = 5 * 60_000;

interface CacheEntry {
  data:      Connector | null;
  expiresAt: number;
}

const cache:   Map<string, CacheEntry>                   = new Map();
const pending: Map<string, Promise<Connector | null>>    = new Map();

const key = (orgId: string, providerKey: string, userId: string) => `${orgId}|${providerKey}|${userId}`;

export const ConnectorsCache = {
  async getByOrgProviderAndUser(orgId: string, providerKey: string, userId: string): Promise<Connector | null> {
    const k = key(orgId, providerKey, userId);
    const hit = cache.get(k);
    if (hit && hit.expiresAt > Date.now()) return hit.data;

    const inflight = pending.get(k);
    if (inflight) return inflight;

    const p = ConnectorsRepo.getByOrgProviderAndUser(orgId, providerKey, userId)
      .then(row => {
        cache.set(k, { data: row, expiresAt: Date.now() + TTL_MS });
        return row;
      })
      .finally(() => { pending.delete(k); });
    pending.set(k, p);
    return p;
  },

  /** After a token refresh writes back: the next turn must see the new
   *  tokenExpiresAt, or freshConnectorToken refreshes again. */
  put(row: Connector): void {
    if (!row.configuredBy) return;   // org-level rows are not looked up here
    cache.set(key(row.orgId, row.providerKey, row.configuredBy), { data: row, expiresAt: Date.now() + TTL_MS });
  },

  /** Connect / reconnect / disconnect: rare, and the safe move is to
   *  forget everything we hold for the org rather than guess the key. */
  invalidateOrg(orgId: string): void {
    for (const k of cache.keys()) if (k.startsWith(`${orgId}|`)) cache.delete(k);
  },

  clear(): void {
    cache.clear();
    pending.clear();
  },
};
