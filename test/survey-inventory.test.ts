import { describe, it, expect } from 'vitest';
import { inventoryFromGather } from '../src/architect/survey-inventory';

/** The survey is a list the code already has; a model re-typing it cost
 *  $0.03 and six seconds a build and could drop a tool. */
describe('inventoryFromGather', () => {
  const objects = [
    { name: 'Lead', label: 'Lead', custom: false, queryable: true, createable: true, updateable: true },
    { name: 'Project__c', label: 'Project', custom: true, queryable: true, createable: false, updateable: false },
    { name: 'ApexClass', label: 'Apex Class', custom: false, queryable: true, createable: false, updateable: false },
  ];
  const invocables = [
    { kind: 'apex' as const, name: 'ScoreLead', label: 'Score lead' },
    { kind: 'flow' as const, name: 'Send_Welcome', label: 'Send welcome' },
  ];
  const mcp = [
    { provider: 'salesforce_mcp', url: 'u', tools: [{ name: 'find', description: 'x'.repeat(300) }, { name: 'soqlQuery', description: 'run soql' }] },
    { provider: 'gmail', url: 'u', tools: [], error: 'not connected' },
  ];
  const crud = [{ sobject: 'Lead', operations: ['create', 'update', 'query'] }];

  it('keeps the same keys the model returned, with core and custom objects only', () => {
    const out = inventoryFromGather({ objects, invocables, mcp, knowledgeBases: [], crud, coreObjects: new Set(['Lead']) }) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['objects', 'invocableApex', 'flows', 'mcpTools', 'crudAvailable', 'knowledgeBases', 'permissionGaps', 'excludedWithReason', 'counts']);
    expect((out.objects as Array<{ name: string }>).map(o => o.name)).toEqual(['Lead', 'Project__c']);
    expect(out.invocableApex).toEqual([{ name: 'ScoreLead', label: 'Score lead' }]);
    expect(out.flows).toEqual([{ name: 'Send_Welcome', label: 'Send welcome' }]);
    expect(out.crudAvailable).toBe(crud);
  });
  it('lists every tool with its connector, clips descriptions, and names the servers that did not answer', () => {
    const out = inventoryFromGather({ objects, invocables, mcp, knowledgeBases: [], crud, coreObjects: new Set() }) as Record<string, unknown>;
    const tools = out.mcpTools as Array<{ connector: string; name: string; description: string }>;
    expect(tools.map(t => `${t.connector}:${t.name}`)).toEqual(['salesforce_mcp:find', 'salesforce_mcp:soqlQuery']);
    expect(tools[0].description).toHaveLength(200);
    expect(out.excludedWithReason).toEqual([{ name: 'gmail', reason: 'not connected: not connected' }]);
    expect(out.counts).toMatchObject({ mcpTools: 2, flows: 1, invocableApex: 1 });
  });
});
