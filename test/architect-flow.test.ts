import { describe, it, expect } from 'vitest';
import { compileFlow, describeFlow, validateFlow, type FlowStep } from '../src/architect/flow';
import { applySpecPatch, isSpecPatch } from '../src/architect/spec-merge';
import type { AgentSpec } from '../src/architect/spec';

/**
 * The automation steps an Architect design may carry. The checks are the
 * engine's own limits; the wiring must land on the ports the engine routes
 * on (yes/no, each/done, approved/rejected, out), or a correct-looking
 * flow silently does nothing.
 */
const dealSweep: FlowStep[] = [
  { step: 'query_records', soql: "SELECT Id, Name, Amount FROM Opportunity WHERE AccountId = '{!recordId}'", as: 'deals' },
  {
    step: 'loop', over: '{!deals.records}', as: 'deal', body: [
      { step: 'if', condition: '{!deal.Amount} >= 50000', then: [{ step: 'create_record', object: 'Task', fields: { Subject: 'Review {!deal.Name}', WhatId: '{!deal.Id}' } }] },
    ],
  },
  { step: 'agent' },
  { step: 'call_tool', connector: 'gmail', tool: 'send_email', params: { to: 'owner@example.com', body: '{!ai.finalText}' } },
];

describe('validateFlow', () => {
  it('passes a query → loop → if → email flow', () => {
    expect(validateFlow(dealSweep)).toEqual([]);
  });

  it('refuses what the engine refuses: nested loops, waits in loops, compound conditions', () => {
    const errs = validateFlow([
      { step: 'query_records', soql: 'SELECT Id FROM Account', as: 'rows' },
      {
        step: 'loop', over: '{!rows.records}', body: [
          { step: 'loop', over: '{!rows.records}', body: [{ step: 'post_chatter', message: 'x' }] },
          { step: 'wait', amount: 1, unit: 'hours' },
          { step: 'if', condition: '{!item.A} > 1 and {!item.B} > 2', then: [{ step: 'post_chatter', message: 'y' }] },
        ],
      },
    ]).map(e => e.message);
    expect(errs.some(m => m.includes('inside another loop'))).toBe(true);
    expect(errs.some(m => m.includes('wait cannot run inside a loop'))).toBe(true);
    expect(errs.some(m => m.includes('one comparison per if'))).toBe(true);
  });

  it('catches a reference to a name nothing defined, and {!ai} before the agent step', () => {
    const errs = validateFlow([
      { step: 'post_chatter', message: '{!ai.finalText}' },
      { step: 'create_task', subject: 'Call {!acct.Name}' },
      { step: 'agent' },
    ]).map(e => e.message);
    expect(errs.some(m => m.includes('before the agent step'))).toBe(true);
    expect(errs.some(m => m.includes('{!acct...} does not name anything'))).toBe(true);
  });

  it('does not let a name from inside a branch leak past it, and refuses reserved names', () => {
    const errs = validateFlow([
      { step: 'if', condition: '{!recordId} != \'\'', then: [{ step: 'get_record', object: 'Account', as: 'acct' }] },
      { step: 'post_chatter', message: '{!acct.Name}' },
      { step: 'set_variable', name: 'record', value: 'x' },
    ]).map(e => e.message);
    expect(errs.some(m => m.includes('{!acct...}'))).toBe(true);
    expect(errs.some(m => m.includes('reserved'))).toBe(true);
  });
});

describe('compileFlow', () => {
  it('wires each step on the port the engine routes on', () => {
    const { nodes, edges, usesAgent } = compileFlow(dealSweep, [{ from: 'start', port: 'out' }], { x: 0, y: 0 });
    expect(usesAgent).toBe(true);
    expect(nodes.map(n => n.nodeSubType)).toEqual(['query_records', 'loop', 'if_else', 'create_record', 'call_tool']);
    const e = (from: number | 'agent' | 'start', port: string, to: number | 'agent') => ({ from, port, to });
    expect(edges).toEqual([
      e('start', 'out', 0),   // trigger → query
      e(0, 'out', 1),         // query → loop
      e(1, 'each', 2),        // loop body → if
      e(2, 'yes', 3),         // if yes → create task record
      e(1, 'done', 'agent'),  // after the loop → the AI agent
      e('agent', 'out', 4),   // AI → email
    ]);
    expect(nodes[1].config).toMatchObject({ collectionVar: '{!deals.records}', iteratorVar: 'deal', maxIterations: 25 });
    expect(nodes[4].config).toMatchObject({ provider: 'gmail', toolName: 'send_email', toolKind: 'standard' });
    expect(JSON.parse(nodes[3].config.fieldMappings as string)).toEqual({ Subject: 'Review {!deal.Name}', WhatId: '{!deal.Id}' });
  });

  it('joins both branches of an if into the next step, and an empty branch goes straight on', () => {
    const { edges } = compileFlow([
      { step: 'if', condition: '{!recordId} != \'\'', then: [{ step: 'post_chatter', message: 'a' }] },
      { step: 'create_task', subject: 'b' },
    ], [{ from: 'start', port: 'out' }], { x: 0, y: 0 });
    expect(edges).toContainEqual({ from: 1, port: 'out', to: 2 });
    expect(edges).toContainEqual({ from: 0, port: 'no', to: 2 });
  });

  it('continues after an approval only when approved', () => {
    const { edges } = compileFlow([
      { step: 'approval', rejected: [{ step: 'post_chatter', message: 'rejected' }] },
      { step: 'update_record', object: 'Opportunity', fields: { StageName: 'Negotiation' } },
    ], [{ from: 'start', port: 'out' }], { x: 0, y: 0 });
    expect(edges).toContainEqual({ from: 0, port: 'approved', to: 2 });
    expect(edges).toContainEqual({ from: 0, port: 'rejected', to: 1 });
    expect(edges.filter(x => x.to === 2)).toHaveLength(1);
  });

  it('describes the flow line by line for the reviewer', () => {
    const lines = describeFlow(dealSweep);
    expect(lines[0]).toContain('Query → deals');
    expect(lines.some(l => l.includes('If {!deal.Amount} >= 50000'))).toBe(true);
  });
});

describe('design patches', () => {
  it('replace the whole flow when the patch carries one', () => {
    const spec = { specVersion: '1.0', name: 'x', department: 'Sales', trigger: { type: 'webhook' }, nodes: [], edges: [], budgets: { maxSteps: 5, maxCostUsd: 1, timeoutSeconds: 60 }, flow: dealSweep } as AgentSpec;
    const patch = { flow: [{ step: 'agent' }] };
    expect(isSpecPatch(patch)).toBe(true);
    expect(applySpecPatch(spec, patch as never).spec.flow).toEqual([{ step: 'agent' }]);
    expect(spec.flow).toBe(dealSweep);
  });
});

describe('compileSpec with a flow', () => {
  const fakeConn = () => {
    const written: { def?: Record<string, unknown>; nodes?: Array<Record<string, unknown>> } = {};
    const conn = {
      query: async (soql: string) => (soql.includes('AiEngineConnection__c')
        ? { records: [{ EngineType__c: 'gpt4', DefaultModel__c: 'gpt-5.5' }] }
        : { records: [] }),
      sobject: (name: string) => ({
        insert: async (rows: unknown) => {
          if (name === 'AgentDefinition__c') { written.def = rows as Record<string, unknown>; return { success: true, id: 'a01' }; }
          written.nodes = rows as Array<Record<string, unknown>>;
          return (rows as unknown[]).map(() => ({ success: true }));
        },
      }),
    };
    return { conn, written };
  };
  const spec = (): AgentSpec => ({
    specVersion: '1.0', name: 'Deal sweep', department: 'Sales', trigger: { type: 'webhook' },
    nodes: [{ id: 'root', type: 'agent', label: 'Deal sweeper', instructions: 'Write a short summary of the large open deals for the owner.', model: { tier: 'large' } }],
    edges: [], budgets: { maxSteps: 8, maxCostUsd: 1, timeoutSeconds: 60 }, flow: dealSweep,
  } as AgentSpec);

  it('enters the flow from the trigger and saves every port', async () => {
    const { compileSpec } = await import('../src/architect/compiler');
    const { conn, written } = fakeConn();
    const res = await compileSpec(spec(), { conn: conn as never, orgId: 'org', executeType: 'Trigger' });
    const types = written.nodes!.map(n => `${n.NodeType__c}:${n.NodeSubType__c}`);
    expect(types).toEqual(['ai:gpt4', 'trigger:webhook', 'action:query_records', 'logic:loop', 'logic:if_else', 'action:create_record', 'action:call_tool']);
    const { connections } = JSON.parse(written.def!.CanvasJson__c as string) as { connections: Array<{ fromIndex: number; toIndex: number; fromPort: string }> };
    const wires = connections.map(c => `${c.fromIndex}:${c.fromPort}->${c.toIndex}`);
    expect(wires).toEqual(['1:out->2', '2:out->3', '3:each->4', '4:yes->5', '3:done->0', '0:out->6']);
    expect(res.notes.some(n => n.includes('5 automation steps'))).toBe(true);
  });

  it('leaves a chat agent alone and says so', async () => {
    const { compileSpec } = await import('../src/architect/compiler');
    const { conn, written } = fakeConn();
    const res = await compileSpec(spec(), { conn: conn as never, orgId: 'org', executeType: 'Chat' });
    expect(written.nodes).toHaveLength(1);
    expect(res.notes.some(n => n.includes('not built'))).toBe(true);
  });
});
