import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';

/**
 * A WRITE FORGETS THE RECORD, WHOEVER DID THE WRITING.
 *
 * The record block the prompt carries is cached for a minute. After a
 * tool writes to that record, the next turn must see what it wrote. The
 * first version keyed this on two CRM MCP tool names, which meant a
 * custom Apex action or another server writing the same record left the
 * block stale. Now: any tool whose name says it writes, and every
 * Salesforce Id its arguments carry, at any nesting -- no tool, server,
 * object or argument name assumed.
 */
const invalidated: string[] = [];

vi.mock('../src/chat/adapters/shared', () => ({
  ensureMcpServerAwake: vi.fn(async () => { /* awake */ }),
}));
vi.mock('../src/chat/record-context', () => ({
  invalidateRecordContext: vi.fn((id: string) => { invalidated.push(id); }),
}));

const anyArgs = z.record(z.unknown());
const mk = (name: string) => ({ name, description: name, schema: anyArgs, invoke: async () => JSON.stringify({ success: true }) });

vi.mock('@langchain/mcp-adapters', () => ({
  MultiServerMCPClient: class {
    async getTools() {
      return [
        mk('updateSobjectRecord'),
        mk('apex__UpdateLeadStatus'),
        mk('bulkUpdateSobjectRecords'),
        mk('createSobjectRecord'),
        mk('getRelatedRecords'),
        mk('soqlQuery'),
      ];
    }
    async close() { /* no-op */ }
  },
}));

const { loadMcpTools } = await import('../src/lc/mcp-tools');

const LEAD = '00Qg5000008few9EAA';
let byName: Map<string, { invoke: (a: unknown) => Promise<unknown> }>;

describe('a write invalidates the record context', () => {
  beforeEach(async () => {
    invalidated.length = 0;
    const loaded = await loadMcpTools([{ name: 'crm', url: 'https://crm.example.com/mcp', token: `t${Math.random()}`, allowedTools: [] }]);
    byName = new Map(loaded.tools.map(t => [t.name, t as never]));
  });

  it('the CRM update tool, by its id argument', async () => {
    await byName.get('updateSobjectRecord')!.invoke({ 'sobject-name': 'Lead', id: LEAD, body: { Budget__c: '5Cr+' } });
    expect(invalidated).toEqual([LEAD]);
  });

  it('a custom Apex action, whatever it calls the argument', async () => {
    await byName.get('apex__UpdateLeadStatus')!.invoke({ leadId: LEAD, status: 'Working' });
    expect(invalidated).toEqual([LEAD]);
  });

  it('a bulk write, with the Ids nested inside records', async () => {
    const OTHER = '00Qg5000008cYQfEAM';
    await byName.get('bulkUpdateSobjectRecords')!.invoke({ 'sobject-name': 'Lead', records: [{ Id: LEAD }, { Id: OTHER }] });
    expect(new Set(invalidated)).toEqual(new Set([LEAD, OTHER]));
  });

  it('a create carrying a lookup to the record (an Event on the Lead)', async () => {
    await byName.get('createSobjectRecord')!.invoke({ 'sobject-name': 'Event', body: { Subject: 'Call', WhoId: LEAD } });
    expect(invalidated).toEqual([LEAD]);
  });

  it('NOT a read, even one that carries the same Id', async () => {
    await byName.get('getRelatedRecords')!.invoke({ id: LEAD, relationship: 'Tasks' });
    await byName.get('soqlQuery')!.invoke({ query: `SELECT Id FROM Lead WHERE Id = '${LEAD}'` });
    expect(invalidated).toEqual([]);
  });
});
