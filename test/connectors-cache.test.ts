import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * ONE POSTGRES ROUND TRIP PER TURN, FOR A ROW THAT ALMOST NEVER CHANGES.
 *
 * The personal-connector lookup measured 465-469ms three times over -- a
 * fresh process, a warm one, before and after a deploy. That is what one
 * round trip to this database costs from where the server runs, and it
 * was the largest server-side cost left on a warm turn.
 */

let reads = 0;
let rowFor: Record<string, unknown> | null = null;

vi.mock('../src/db/connectors.repo', () => ({
  ConnectorsRepo: {
    getByOrgProviderAndUser: vi.fn(async () => { reads++; return rowFor; }),
  },
}));

const { ConnectorsCache } = await import('../src/db/connectors-cache');

const row = (over: Record<string, unknown> = {}) => ({
  id: 'c1', orgId: 'org', providerKey: 'salesforce_mcp', configuredBy: 'user1',
  status: 'Connected', accessToken: 'tok', refreshToken: 'r', tokenExpiresAt: null,
  updatedAt: new Date(), ...over,
}) as never;

let clockOffset = 0;
const realNow = Date.now;

describe('ConnectorsCache', () => {
  beforeEach(() => {
    reads = 0; rowFor = null; clockOffset = 0;
    ConnectorsCache.clear();
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
  });

  it('reads once, then serves the row from memory', async () => {
    rowFor = row();
    await ConnectorsCache.getByOrgProviderAndUser('org', 'salesforce_mcp', 'user1');
    await ConnectorsCache.getByOrgProviderAndUser('org', 'salesforce_mcp', 'user1');
    await ConnectorsCache.getByOrgProviderAndUser('org', 'salesforce_mcp', 'user1');
    expect(reads).toBe(1);
  });

  it('caches a NULL too -- a person with no connection must not pay forever', async () => {
    rowFor = null;
    expect(await ConnectorsCache.getByOrgProviderAndUser('org', 'salesforce_mcp', 'nobody')).toBeNull();
    expect(await ConnectorsCache.getByOrgProviderAndUser('org', 'salesforce_mcp', 'nobody')).toBeNull();
    expect(reads).toBe(1);
  });

  it('put() replaces the row so a refreshed token is what the next turn sees', async () => {
    rowFor = row({ accessToken: 'old' });
    await ConnectorsCache.getByOrgProviderAndUser('org', 'salesforce_mcp', 'user1');
    ConnectorsCache.put(row({ accessToken: 'new', tokenExpiresAt: new Date(Date.now() + 3_600_000) }));
    const got = await ConnectorsCache.getByOrgProviderAndUser('org', 'salesforce_mcp', 'user1');
    expect((got as { accessToken: string }).accessToken).toBe('new');
    expect(reads).toBe(1);
  });

  it('invalidateOrg() drops the null the moment someone connects', async () => {
    rowFor = null;
    await ConnectorsCache.getByOrgProviderAndUser('org', 'salesforce_mcp', 'user1');
    ConnectorsCache.invalidateOrg('org');
    rowFor = row();
    const got = await ConnectorsCache.getByOrgProviderAndUser('org', 'salesforce_mcp', 'user1');
    expect(got).not.toBeNull();
    expect(reads).toBe(2);
  });

  it('invalidateOrg() leaves other orgs alone', async () => {
    rowFor = row();
    await ConnectorsCache.getByOrgProviderAndUser('org', 'salesforce_mcp', 'user1');
    await ConnectorsCache.getByOrgProviderAndUser('other', 'salesforce_mcp', 'user1');
    ConnectorsCache.invalidateOrg('org');
    await ConnectorsCache.getByOrgProviderAndUser('other', 'salesforce_mcp', 'user1');
    expect(reads).toBe(2);
  });

  it('keys by user: two people in one org never see each other\'s row', async () => {
    rowFor = row({ configuredBy: 'user1' });
    await ConnectorsCache.getByOrgProviderAndUser('org', 'salesforce_mcp', 'user1');
    rowFor = null;
    expect(await ConnectorsCache.getByOrgProviderAndUser('org', 'salesforce_mcp', 'user2')).toBeNull();
    expect(reads).toBe(2);
  });

  it('expires and re-reads after the TTL', async () => {
    rowFor = row();
    await ConnectorsCache.getByOrgProviderAndUser('org', 'salesforce_mcp', 'user1');
    clockOffset += 6 * 60_000;
    await ConnectorsCache.getByOrgProviderAndUser('org', 'salesforce_mcp', 'user1');
    expect(reads).toBe(2);
  });
});
