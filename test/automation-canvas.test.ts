import { describe, it, expect } from 'vitest';
import { connectorOffers, KNOWN_CONNECTOR_TOOLS } from '../src/architect/connector-tools';
import { validateFlow, type FlowStep } from '../src/architect/flow';
import { previewSpec } from '../src/architect/build-detail';
import type { AgentSpec } from '../src/architect/spec';

/**
 * An automation agent is designed as steps on the canvas: real conditions,
 * record writes anywhere, and connector steps even before the connector is
 * signed in to. Examples span several objects and connectors on purpose.
 */
describe('connectors the designer may use', () => {
  it('offers connected ones with live tools and unconnected ones with known tools', () => {
    const offers = connectorOffers([
      { provider: 'salesforce_mcp', tools: [{ name: 'soqlQuery' }, { name: 'createSobjectRecord' }] },
      { provider: 'gmail', tools: [], error: 'not connected' },
      { provider: 'outlook', tools: [], error: 'not connected' },
      { provider: 'slack', tools: [], error: 'not connected' },
      { provider: 'broken', tools: [], error: 'timeout' },
    ]);
    expect(offers.map(o => [o.connector, o.connected])).toEqual([['salesforce_mcp', true], ['gmail', false], ['outlook', false], ['slack', false]]);
    expect(offers.find(o => o.connector === 'gmail')!.tools).toContain('sendEmail');
    expect(offers.find(o => o.connector === 'slack')!.tools).toEqual([]);
    expect(KNOWN_CONNECTOR_TOOLS.outlook).toContain('createDraft');
  });
});

describe('steps a real automation needs', () => {
  const flow: FlowStep[] = [
    { step: 'get_record', object: 'Opportunity', as: 'opp' },
    { step: 'get_record', object: 'Account', id: '{!opp.AccountId}', fields: 'Id,Name,Type', as: 'acct' },
    { step: 'query_records', soql: "SELECT Id, Name, Title, Email FROM Contact WHERE AccountId = '{!acct.Id}'", as: 'people' },
    {
      step: 'loop', over: '{!people.records}', as: 'person', body: [
        {
          step: 'if', condition: "{!person.Title} contains 'finance' OR {!person.Title} contains 'cfo'", then: [
            { step: 'query_records', soql: "SELECT Id FROM Task WHERE WhoId = '{!person.Id}' AND Subject = 'Intro call'", as: 'found' },
            { step: 'if', condition: '{!found.count} == 0', then: [
              { step: 'create_record', object: 'Task', fields: { Subject: 'Intro call', WhoId: '{!person.Id}', ActivityDate: '{!ADD_BUSINESS_DAYS(TODAY, 3)}' } },
              { step: 'call_tool', connector: 'gmail', tool: 'sendEmail', params: { to: '{!person.Email}', subject: 'Welcome {!person.Name}' } },
            ] },
          ],
        },
      ],
    },
    { step: 'if', condition: "{!opp.Amount} >= 100000 AND {!acct.Type} is blank", then: [
      { step: 'update_record', object: 'Account', id: '{!acct.Id}', fields: { Type: 'Customer - Direct' } },
    ] },
    { step: 'call_tool', connector: 'outlook', tool: 'sendEmail', params: { to: 'sales@example.com', subject: '{!FORMAT_NUMBER(opp.Amount)} closed, {!YEAR(ADD_MONTHS(opp.CloseDate, 12))} renewal' } },
  ];

  it('validates: functions, AND/OR, record ids and connector steps are all accepted', () => {
    expect(validateFlow(flow)).toEqual([]);
  });

  it('still catches a name nothing defined, inside a function', () => {
    const errs = validateFlow([{ step: 'create_task', subject: 'Due {!ADD_DAYS(deal.CloseDate, 3)}' }]).map(e => e.message);
    expect(errs.some(m => m.includes('{!deal...}'))).toBe(true);
  });

  it('shows the steps in the build preview: trigger, steps, ports', () => {
    const spec = {
      specVersion: '1.0', name: 'x', department: 'Sales', trigger: { type: 'manual' },
      nodes: [{ id: 'root', type: 'agent', label: 'Root', instructions: 'x' }], edges: [],
      budgets: { maxSteps: 5, maxCostUsd: 1, timeoutSeconds: 60 }, flow,
    } as unknown as AgentSpec;
    const { nodes, connections } = previewSpec(spec);
    const types = nodes.map(n => `${n.nodeType}:${n.nodeSubType}`);
    expect(types[0]).toBe('ai:gpt4');
    expect(types).toContain('trigger:record');
    expect(types.filter(t => t === 'logic:loop')).toHaveLength(1);
    expect(types.filter(t => t === 'logic:if_else')).toHaveLength(3);
    expect(types.filter(t => t === 'action:call_tool')).toHaveLength(2);
    const ports = new Set(connections.map(c => c.fromPort));
    for (const p of ['out', 'each', 'done', 'yes', 'no']) expect(ports.has(p)).toBe(true);
  });
});
