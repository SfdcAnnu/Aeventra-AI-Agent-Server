import { describe, it, expect } from 'vitest';
import { closestName, dice, repairNames } from '../src/architect/name-repair';
import type { AgentSpec } from '../src/architect/spec';

/**
 * A misspelt tool name used to cost a whole paid re-emit of the design.
 * The repair fixes what is unambiguous and refuses to guess: a wrong tool
 * shipped is worse than a rejected one.
 */
const available = {
  mcp: [
    { connector: 'salesforce_mcp', tools: ['find', 'getObjectSchema', 'createSobjectRecord', 'updateSobjectRecord', 'soqlQuery'] },
    { connector: 'gmail', tools: ['send_email', 'list_messages'] },
  ],
  crud: [
    { sobject: 'Lead', operations: ['create', 'update', 'query'] },
    { sobject: 'Project__c', operations: ['query'] },
    { sobject: 'Event', operations: ['create', 'query'] },
  ],
  invocables: [{ kind: 'flow' as const, name: 'Send_Lead_Onboarding_Email' }],
};

const tool = (id: string, action: Record<string, unknown>) => ({ id, type: 'tool' as const, label: id, action: { discovered: true as const, ...action } });
const spec = (nodes: unknown[]): AgentSpec => ({ specVersion: '1.0', trigger: { type: 'manual' }, nodes, edges: [] } as unknown as AgentSpec);

describe('closestName', () => {
  it('forgives case and separators, and a connector prefix', () => {
    expect(closestName('get_object_schema', available.mcp[0].tools)).toBe('getObjectSchema');
    expect(closestName('GETOBJECTSCHEMA', available.mcp[0].tools)).toBe('getObjectSchema');
    expect(closestName('salesforce_mcp.find', available.mcp[0].tools)).toBe('find');
  });
  it('accepts a close spelling with the same verb', () => {
    expect(dice('getsobjectschema', 'getobjectschema')).toBeGreaterThan(0.85);
    expect(closestName('get_sobject_schema', available.mcp[0].tools)).toBe('getObjectSchema');
  });
  it('never changes the verb, however close the rest is', () => {
    expect(closestName('deleteSobjectRecord', available.mcp[0].tools)).toBeNull();
    expect(closestName('upsertSobjectRecord', available.mcp[0].tools)).toBeNull();
  });
  it('refuses when nothing is close or two are equally close', () => {
    expect(closestName('sendWhatsApp', available.mcp[0].tools)).toBeNull();
    expect(closestName('x', ['x1', 'x2'])).toBeNull();
  });
});

describe('repairNames', () => {
  it('corrects the tool name, the connector, the object case and the operation alias, and says so', () => {
    const s = spec([
      tool('schema', { kind: 'mcp', toolName: 'get_sobject_schema' }),
      tool('mail', { kind: 'mcp', toolName: 'send_email', connector: 'salesforce_mcp' }),
      tool('newLead', { kind: 'crud', sobject: 'lead', operation: 'insert' }),
      tool('projects', { kind: 'crud', sobject: 'Project', operation: 'read' }),
      tool('welcome', { kind: 'flow_invocable', toolName: 'send_lead_onboarding_email' }),
    ]);
    const notes = repairNames(s, available);
    const a = (id: string) => s.nodes.find(n => n.id === id)!.action!;
    expect(a('schema').toolName).toBe('getObjectSchema');
    expect(a('schema').connector).toBe('salesforce_mcp');
    expect(a('mail').connector).toBe('gmail');
    expect(a('newLead')).toMatchObject({ sobject: 'Lead', operation: 'create' });
    expect(a('projects')).toMatchObject({ sobject: 'Project__c', operation: 'query' });
    expect(a('welcome').toolName).toBe('Send_Lead_Onboarding_Email');
    expect(notes).toHaveLength(7);   // two on the projects node: object and operation
    expect(notes[0]).toContain('getObjectSchema');
  });
  it('leaves a name it cannot vouch for, and an operation the object does not allow', () => {
    const s = spec([
      tool('wa', { kind: 'mcp', toolName: 'sendWhatsAppMessage' }),
      tool('delProject', { kind: 'crud', sobject: 'Project__c', operation: 'remove' }),
    ]);
    expect(repairNames(s, available)).toEqual([]);
    expect(s.nodes[0].action!.toolName).toBe('sendWhatsAppMessage');
    expect(s.nodes[1].action!.operation).toBe('remove');
  });
  it('is a no-op on a shapeless answer', () => {
    expect(repairNames({} as AgentSpec, available)).toEqual([]);
  });
});
