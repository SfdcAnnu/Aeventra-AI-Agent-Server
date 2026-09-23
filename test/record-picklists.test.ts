import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * THE VALID OPTIONS RIDE IN THE SYSTEM PROMPT ON EVERY TURN.
 *
 * A live agent read the Lead schema, received Commercial's two projects
 * correctly, and eight messages later offered the customer "Commercial
 * Project C" -- which does not exist -- and accepted it. A tool result
 * far back in the history is weak; a fact in the system prompt on the
 * current turn is strong. The record-context block now carries the
 * object's picklist options and their dependencies, decoded from the
 * same validFor bitmaps the CRM MCP server decodes, from a describe
 * cached per object.
 *
 * And after the model writes to the record, the block is dropped, so the
 * next turn shows what was just saved rather than minute-old values.
 */
let retrieves = 0;
let describes = 0;
let describeFails = false;

const leadFields = [
  { name: 'Id', type: 'id' },
  { name: 'LastName', type: 'string' },
  { name: 'Status', type: 'picklist', picklistValues: [
    { value: 'In Process', active: true }, { value: 'WhatsApp Qualified', active: true }, { value: 'Lost Lead', active: true },
  ] },
  { name: 'Project_Type__c', type: 'picklist', picklistValues: [
    { value: 'Villa', active: true }, { value: 'Apartment', active: true }, { value: 'Commercial', active: true }, { value: 'Other', active: true },
  ] },
  { name: 'Project_Name__c', type: 'picklist', controllerName: 'Project_Type__c', dependentPicklist: true, picklistValues: [
    { value: 'Villa Project A', active: true, validFor: 'gAAA' },
    { value: 'Villa Project B', active: true, validFor: 'gAAA' },
    { value: 'Villa Project C', active: true, validFor: 'gAAA' },
    { value: 'Apartment Project A', active: true, validFor: 'QAAA' },
    { value: 'Apartment Project B', active: true, validFor: 'QAAA' },
    { value: 'Commercial Project A', active: true, validFor: 'IAAA' },
    { value: 'Commercial Project B', active: true, validFor: 'IAAA' },
    { value: 'Other Project A', active: true, validFor: 'EAAA' },
  ] },
  { name: 'Budget__c', type: 'picklist', picklistValues: [
    { value: '50L - 1Cr', active: true }, { value: '1Cr - 2Cr', active: true }, { value: '2Cr - 5Cr', active: true }, { value: '5Cr+', active: true },
  ] },
  // A standard picklist that is not on the short allow-list must NOT bloat the block.
  { name: 'Industry', type: 'picklist', picklistValues: Array.from({ length: 30 }, (_, i) => ({ value: `Industry ${i}`, active: true })) },
];

vi.mock('../src/salesforce/per-org-connection', () => ({
  getOrgConnection: vi.fn(async () => ({
    describeGlobal: async () => ({ sobjects: [{ keyPrefix: '00Q', name: 'Lead' }] }),
    sobject: (type: string) => ({
      retrieve: async (id: string) => { retrieves++; return { attributes: { type }, Id: id, LastName: 'Govind', Project_Type__c: 'Commercial' }; },
      describe: async () => { describes++; if (describeFails) throw new Error('describe down'); return { fields: leadFields }; },
    }),
  })),
}));

const { buildRecordContextBlock, invalidateRecordContext, _clearRecordContextCaches } = await import('../src/chat/record-context');

describe('picklist options in the record context', () => {
  beforeEach(() => { retrieves = 0; describes = 0; describeFails = false; _clearRecordContextCaches(); });

  it('lists each custom picklist with its exact values', async () => {
    const block = await buildRecordContextBlock('org', 'Lead', '00Qg5000008few9EAA');
    expect(block).toContain('Project_Type__c: Villa | Apartment | Commercial | Other');
    expect(block).toContain('Budget__c: 50L - 1Cr | 1Cr - 2Cr | 2Cr - 5Cr | 5Cr+');
    expect(block).toContain('Status: In Process | WhatsApp Qualified | Lost Lead');
  });

  it('spells out the dependency, so Commercial has exactly two projects and no Project C', async () => {
    const block = await buildRecordContextBlock('org', 'Lead', '00Qg5000008few9EAA');
    expect(block).toContain('Commercial: Commercial Project A | Commercial Project B');
    expect(block).toContain('Villa: Villa Project A | Villa Project B | Villa Project C');
    expect(block).not.toContain('Commercial Project C');
  });

  it('leaves large standard picklists out rather than bloating the prompt', async () => {
    const block = await buildRecordContextBlock('org', 'Lead', '00Qg5000008few9EAA');
    expect(block).not.toContain('Industry 3');
  });

  it('describes the object once per org, not once per record', async () => {
    await buildRecordContextBlock('org', 'Lead', '00Qg5000008few9EAA');
    await buildRecordContextBlock('org', 'Lead', '00Qg5000008cYQfEAM');
    expect(describes).toBe(1);
  });

  it('still returns the record values when describe fails', async () => {
    describeFails = true;
    const block = await buildRecordContextBlock('org', 'Lead', '00Qg5000008few9EAA');
    expect(block).toContain('Govind');
    expect(block).not.toContain('PICKLIST OPTIONS');
  });

  it('a write to the record drops its cached block, so the next turn re-reads it', async () => {
    await buildRecordContextBlock('org', 'Lead', '00Qg5000008few9EAA');
    await buildRecordContextBlock('org', 'Lead', '00Qg5000008few9EAA');
    expect(retrieves).toBe(1);
    invalidateRecordContext('00Qg5000008few9EAA');
    await buildRecordContextBlock('org', 'Lead', '00Qg5000008few9EAA');
    expect(retrieves).toBe(2);
  });
});
