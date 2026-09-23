import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A FLOW HANDS OVER A RECORD ID AND NO TYPE, AND GOT NO PREFETCH.
 *
 * headless.ts sends recordContextType: null. buildRecordContextBlock
 * returned null unless both were set, so a trigger run spent a tool call
 * rediscovering the fields a chat on the same record is handed for free.
 * The first three characters of an Id name the object.
 */
let describeCalls = 0;

vi.mock('../src/salesforce/per-org-connection', () => ({
  getOrgConnection: vi.fn(async () => ({
    describeGlobal: async () => {
      describeCalls++;
      return { sobjects: [{ keyPrefix: '00Q', name: 'Lead' }, { keyPrefix: '003', name: 'Contact' }] };
    },
    sobject: (type: string) => ({
      retrieve: async (id: string) => ({ attributes: { type }, Id: id, LastName: 'Pandey', Email: 'govind@gmail.com' }),
    }),
  })),
}));

const { sobjectTypeFromId, buildRecordContextBlock } = await import('../src/chat/record-context');

describe('record type from Id', () => {
  beforeEach(() => { describeCalls = 0; });

  it('names the object from the key prefix', async () => {
    expect(await sobjectTypeFromId('org', '00Qg5000008cYQfEAM')).toBe('Lead');
    expect(await sobjectTypeFromId('org', '003g5000001abcdAAA')).toBe('Contact');
  });

  it('asks describeGlobal once per org, not once per Id', async () => {
    await sobjectTypeFromId('org2', '00Qg5000008cYQfEAM');
    await sobjectTypeFromId('org2', '00Qg5000008cYQgEAM');
    await sobjectTypeFromId('org2', '003g5000001abcdAAA');
    expect(describeCalls).toBe(1);
  });

  it('returns null for an unknown prefix or a malformed Id', async () => {
    expect(await sobjectTypeFromId('org', 'ZZZg5000008cYQfEAM')).toBeNull();
    expect(await sobjectTypeFromId('org', '00Q')).toBeNull();
    expect(await sobjectTypeFromId('org', '')).toBeNull();
  });

  it('builds the record block when only the Id is known -- the Flow case', async () => {
    const block = await buildRecordContextBlock('org', null, '00Qg5000008cYQfEAM');
    expect(block).not.toBeNull();
    expect(block).toContain('LEAD');
    expect(block).toContain('govind@gmail.com');
  });

  it('still returns nothing when there is no Id at all', async () => {
    expect(await buildRecordContextBlock('org', null, null)).toBeNull();
  });
});
