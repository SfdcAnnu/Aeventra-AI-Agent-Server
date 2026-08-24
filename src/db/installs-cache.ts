/**
 * In-memory cache for OrgInstall records with pending-promise dedup.
 *
 *   • First read for an org: hits SQLite, caches for TTL_MS.
 *   • Subsequent reads within TTL: served from RAM, no DB hit.
 *   • Concurrent misses: coalesced into a single DB read via a promise map,
 *     so if 20 chat turns land in the same 5 ms burst, we do 1 read, not 20.
 *
 * Multi-instance deployment: each Node instance keeps its own cache.
 * Source of truth remains the DB — token refreshes are written back to DB
 * and picked up by other instances on their next TTL expiry (max 30 s
 * staleness, which is well within the 2-hour access-token lifetime).
 *
 * Bypass or invalidate:
 *   • `invalidate(orgId)` — call after a token refresh so the new token
 *     is immediately visible to the same instance.
 *   • `clear()` — nuke everything (tests / hot-reload).
 */
import type { OrgInstall } from '@prisma/client';
import { InstallsRepo } from './installs.repo';

const TTL_MS = 30_000;

interface CacheEntry {
  data:      OrgInstall;
  expiresAt: number;
}

const cache:   Map<string, CacheEntry>            = new Map();
const pending: Map<string, Promise<OrgInstall | null>> = new Map();

export const InstallsCache = {
  async findByOrgId(orgId: string): Promise<OrgInstall | null> {
    const hit = cache.get(orgId);
    if (hit && hit.expiresAt > Date.now()) return hit.data;

    const inflight = pending.get(orgId);
    if (inflight) return inflight;

    const p = InstallsRepo.findByOrgId(orgId)
      .then(row => {
        if (row) {
          cache.set(orgId, { data: row, expiresAt: Date.now() + TTL_MS });
        }
        return row;
      })
      .finally(() => {
        pending.delete(orgId);
      });
    pending.set(orgId, p);
    return p;
  },

  /** Update cache after a refresh so subsequent reads see the new token. */
  put(row: OrgInstall): void {
    cache.set(row.orgId, { data: row, expiresAt: Date.now() + TTL_MS });
  },

  invalidate(orgId: string): void {
    cache.delete(orgId);
  },

  clear(): void {
    cache.clear();
    pending.clear();
  },
};
