import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * A 30s EXPIRY RE-READ THE INSTALL ROW ON EVERY HUMAN-PACED TURN.
 *
 * The route reads it to build the org connection; the turn's setup then
 * read it AGAIN, uncached. Two Postgres round trips for one row -- ~470ms
 * of the pre-turn gap on a warm turn. Setup now goes through this cache,
 * and the cache serves a stale row while it reloads behind the turn.
 */

let reads = 0;
let readDelayMs = 0;

vi.mock('../src/db/installs.repo', () => ({
  InstallsRepo: {
    findByOrgId: vi.fn(async (orgId: string) => {
      reads++;
      if (readDelayMs) await new Promise(r => setTimeout(r, readDelayMs));
      return { orgId, sfAccessToken: `tok${reads}`, sfInstanceUrl: 'https://x.my.salesforce.com' };
    }),
  },
}));

const { InstallsCache } = await import('../src/db/installs-cache');

let clockOffset = 0;
const realNow = Date.now;
const advance = (ms: number) => { clockOffset += ms; };
let n = 0;
const org = () => `00D${n++}`;

describe('InstallsCache', () => {
  beforeEach(() => {
    reads = 0; readDelayMs = 0; clockOffset = 0;
    InstallsCache.clear();
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
  });

  it('reads once while fresh', async () => {
    const o = org();
    await InstallsCache.findByOrgId(o);
    await InstallsCache.findByOrgId(o);
    expect(reads).toBe(1);
  });

  it('a stale row does NOT make the turn wait for Postgres', async () => {
    const o = org();
    await InstallsCache.findByOrgId(o);
    advance(60_000);                 // past FRESH_MS, inside STALE_MS
    readDelayMs = 1_500;
    const t0 = realNow();
    const got = await InstallsCache.findByOrgId(o);
    expect(realNow() - t0).toBeLessThan(400);
    expect(got?.orgId).toBe(o);
  });

  it('one reload for however many turns arrive while stale', async () => {
    const o = org();
    await InstallsCache.findByOrgId(o);
    advance(60_000);
    readDelayMs = 100;
    await Promise.all([InstallsCache.findByOrgId(o), InstallsCache.findByOrgId(o), InstallsCache.findByOrgId(o)]);
    await new Promise(r => setTimeout(r, 200));
    expect(reads).toBe(2);
  });

  it('put() after a token refresh is what the next read sees', async () => {
    const o = org();
    await InstallsCache.findByOrgId(o);
    InstallsCache.put({ orgId: o, sfAccessToken: 'refreshed', sfInstanceUrl: 'https://x.my.salesforce.com' } as never);
    const got = await InstallsCache.findByOrgId(o);
    expect((got as { sfAccessToken: string }).sfAccessToken).toBe('refreshed');
    expect(reads).toBe(1);
  });

  it('blocks again once the row is older than the stale window', async () => {
    const o = org();
    await InstallsCache.findByOrgId(o);
    advance(11 * 60_000);
    readDelayMs = 100;
    const t0 = realNow();
    await InstallsCache.findByOrgId(o);
    expect(realNow() - t0).toBeGreaterThanOrEqual(90);
    expect(reads).toBe(2);
  });
});
