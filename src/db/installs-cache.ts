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

// 30s was chosen so a token refreshed on one instance reached the others
// within half a minute. There is one instance, and on it the 30s expiry
// meant every human-paced turn re-read the install row in the route --
// and then read it AGAIN, uncached, in the turn's setup. Two Postgres
// round trips for one row, ~470ms of the pre-turn gap.
//
// Two-stage expiry: inside FRESH_MS serve; past it but inside STALE_MS
// serve what we hold and reload behind the turn. Token freshness is not
// this cache's concern -- ensureFresh() checks expiry on whatever row it
// is handed and put()s the refreshed one -- so a stale row costs nothing
// but one background read.
const FRESH_MS = 30_000;
const STALE_MS = 10 * 60_000;

interface CacheEntry {
  data:       OrgInstall;
  expiresAt:  number;   // fresh until
  staleUntil: number;   // servable-while-reloading until
}

function reload(orgId: string): Promise<OrgInstall | null> {
  const p = InstallsRepo.findByOrgId(orgId)
    .then(row => {
      if (row) {
        const now = Date.now();
        cache.set(orgId, { data: row, expiresAt: now + FRESH_MS, staleUntil: now + STALE_MS });
      }
      return row;
    })
    .finally(() => { pending.delete(orgId); });
  pending.set(orgId, p);
  return p;
}

const cache:   Map<string, CacheEntry>            = new Map();
const pending: Map<string, Promise<OrgInstall | null>> = new Map();

export const InstallsCache = {
  async findByOrgId(orgId: string): Promise<OrgInstall | null> {
    const hit = cache.get(orgId);
    const now = Date.now();
    if (hit && hit.expiresAt > now) return hit.data;

    if (hit && hit.staleUntil > now) {
      if (!pending.has(orgId)) reload(orgId).catch(() => { /* keep serving what we hold */ });
      return hit.data;
    }

    const inflight = pending.get(orgId);
    if (inflight) return inflight;
    return reload(orgId);
  },

  /** Update cache after a refresh so subsequent reads see the new token. */
  put(row: OrgInstall): void {
    const now = Date.now();
    cache.set(row.orgId, { data: row, expiresAt: now + FRESH_MS, staleUntil: now + STALE_MS });
  },

  invalidate(orgId: string): void {
    cache.delete(orgId);
  },

  clear(): void {
    cache.clear();
    pending.clear();
  },
};
